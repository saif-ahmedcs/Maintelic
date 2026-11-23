import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Asset, AssetStatus } from '../assets/entities/asset.entity';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { MaintenancePlan } from '../maintenance-plans/entities/maintenance-plan.entity';
import { RoleName } from '../users/entities/role.entity';
import { User } from '../users/entities/user.entity';
import { WorkOrder, WorkOrderStatus } from './entities/work-order.entity';
import { WorkOrderPart } from './entities/work-order-part.entity';
import { WorkOrdersService } from './work-orders.service';

describe('WorkOrdersService.complete', () => {
  let service: WorkOrdersService;
  let workOrderRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let lockQb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let assetLockQb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let auditService: { record: jest.Mock };
  let inventoryService: { consume: jest.Mock };
  let assetHistoryService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };

  const technician: RequestUser = {
    id: 'tech-1',
    email: 'tech@example.com',
    roles: [RoleName.TECHNICIAN],
  };
  const supervisor: RequestUser = {
    id: 'super-1',
    email: 'super@example.com',
    roles: [RoleName.SUPERVISOR],
  };

  let workOrder: WorkOrder;
  let asset: Asset;
  let plan: MaintenancePlan;
  let users: Record<string, User | undefined>;

  const makeUser = (id: string, roles: RoleName[], isActive = true): User =>
    ({
      id,
      isActive,
      roles: roles.map((name) => ({ id: `role-${name}`, name })),
    }) as unknown as User;

  beforeEach(() => {
    users = {
      'tech-1': makeUser('tech-1', [RoleName.TECHNICIAN]),
      'tech-2': makeUser('tech-2', [RoleName.TECHNICIAN]),
      'super-1': makeUser('super-1', [RoleName.SUPERVISOR]),
    };
    workOrder = {
      id: 'wo-1',
      assetId: 'asset-1',
      maintenancePlanId: 'plan-1',
      status: WorkOrderStatus.IN_PROGRESS,
      assignedToUserId: 'tech-1',
    } as WorkOrder;

    asset = { id: 'asset-1', status: AssetStatus.CRITICAL } as Asset;

    plan = {
      id: 'plan-1',
      intervalDays: 30,
      lastCompletedAt: null,
      nextDueAt: new Date('2020-01-01'),
    } as MaintenancePlan;

    workOrderRepo = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
    lockQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => workOrder),
    };
    assetLockQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => asset),
    };
    manager = {
      createQueryBuilder: jest.fn((entity: unknown) =>
        entity === Asset ? assetLockQb : lockQb,
      ),
      findOne: jest.fn(async (entity: unknown, options?: any) => {
        if (entity === MaintenancePlan) return plan;
        if (entity === User) return users[options?.where?.id] ?? null;
        return null;
      }),
      findOneBy: jest.fn(async () => null),
      create: jest.fn((_entity, plain) => plain),
      save: jest.fn(async (entity) => entity),
    };
    dataSource = { transaction: jest.fn((cb) => cb(manager)) };
    auditService = { record: jest.fn(async () => ({})) };
    inventoryService = { consume: jest.fn() };
    assetHistoryService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };

    service = new WorkOrdersService(
      workOrderRepo as any,
      dataSource as any,
      auditService as any,
      inventoryService as any,
      assetHistoryService as any,
      notificationsService as any,
    );
  });

  it('throws NotFoundException when the work order does not exist', async () => {
    lockQb.getOne.mockResolvedValue(null);

    await expect(
      service.complete('missing-id', {}, technician),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException for a technician who is not the assignee', async () => {
    const otherTech: RequestUser = {
      id: 'tech-2',
      email: 'other@example.com',
      roles: [RoleName.TECHNICIAN],
    };

    await expect(service.complete('wo-1', {}, otherTech)).rejects.toThrow(
      ForbiddenException,
    );
    expect(inventoryService.consume).not.toHaveBeenCalled();
  });

  it('throws ConflictException and consumes nothing when the work order is not IN_PROGRESS', async () => {
    workOrder.status = WorkOrderStatus.OPEN;

    await expect(
      service.complete(
        'wo-1',
        { parts: [{ sparePartId: 'part-1', quantityUsed: 1 }] },
        technician,
      ),
    ).rejects.toThrow(ConflictException);
    expect(inventoryService.consume).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('completes with sufficient stock and produces all six side effects', async () => {
    inventoryService.consume.mockResolvedValue({
      sparePart: { id: 'part-1', sku: 'SKU-1', unitCost: 12.5 },
      transaction: { id: 'txn-1' },
    });

    const result = await service.complete(
      'wo-1',
      { parts: [{ sparePartId: 'part-1', quantityUsed: 2 }] },
      technician,
    );

    // (b)+(c) part locked/consumed via the shared InventoryService, one row per part
    expect(inventoryService.consume).toHaveBeenCalledWith(
      manager,
      'part-1',
      2,
      { workOrderId: 'wo-1', createdByUserId: technician.id },
    );
    expect(result.workOrderParts).toEqual([
      expect.objectContaining({
        workOrderId: 'wo-1',
        sparePartId: 'part-1',
        quantityUsed: 2,
        unitCostAtCompletion: 12.5,
      } as Partial<WorkOrderPart>),
    ]);

    // (d) work order completed, cost totalled
    expect(result.status).toBe(WorkOrderStatus.COMPLETED);
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.totalCost).toBe(25);

    // (e) asset reverted to OPERATIONAL
    expect(asset.status).toBe(AssetStatus.OPERATIONAL);

    // (f) originating plan rolled forward
    expect(plan.lastCompletedAt).toBeInstanceOf(Date);
    expect(plan.nextDueAt).toBeInstanceOf(Date);
    expect(plan.nextDueAt!.getTime()).toBeGreaterThan(Date.now());

    // (g) both audit entries, same manager, correct before/after
    expect(auditService.record).toHaveBeenCalledTimes(2);
    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        entityType: 'WorkOrder',
        entityId: 'wo-1',
        action: 'COMPLETE',
        after: expect.objectContaining({ status: WorkOrderStatus.COMPLETED }),
      }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        entityType: 'Asset',
        entityId: 'asset-1',
        action: 'STATUS_CHANGE',
        before: { status: AssetStatus.CRITICAL },
        after: { status: AssetStatus.OPERATIONAL },
        source: 'work-order-completion',
      }),
    );

    // (h) matching asset_state_history row, same transaction
    expect(assetHistoryService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        assetId: 'asset-1',
        previousStatus: AssetStatus.CRITICAL,
        newStatus: AssetStatus.OPERATIONAL,
        changedByUserId: technician.id,
        source: 'work-order-completion',
      }),
    );
  });

  it('leaves the asset alone when it is already OPERATIONAL at completion', async () => {
    asset.status = AssetStatus.OPERATIONAL;

    await service.complete('wo-1', {}, technician);

    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ entityType: 'WorkOrder', action: 'COMPLETE' }),
    );
    expect(assetHistoryService.record).not.toHaveBeenCalled();
  });

  it('completes with no parts: skips inventory entirely and totals cost to 0', async () => {
    const result = await service.complete('wo-1', {}, technician);

    expect(inventoryService.consume).not.toHaveBeenCalled();
    expect(result.totalCost).toBe(0);
    expect(result.workOrderParts).toEqual([]);
  });

  it('does not touch a maintenance plan when the work order has none', async () => {
    workOrder.maintenancePlanId = null;

    await service.complete('wo-1', {}, technician);

    expect(manager.findOne).not.toHaveBeenCalledWith(
      MaintenancePlan,
      expect.anything(),
    );
  });

  it('completes the work order but never reactivates a DECOMMISSIONED asset', async () => {
    asset.status = AssetStatus.DECOMMISSIONED;

    const result = await service.complete('wo-1', {}, technician);

    expect(result.status).toBe(WorkOrderStatus.COMPLETED);
    expect(asset.status).toBe(AssetStatus.DECOMMISSIONED);
    expect(manager.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'asset-1' }),
    );
    expect(assetHistoryService.record).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ action: 'STATUS_CHANGE' }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ action: 'COMPLETE' }),
    );
  });

  it('still reactivates a non-decommissioned asset to OPERATIONAL on completion', async () => {
    asset.status = AssetStatus.UNDER_MAINTENANCE;

    await service.complete('wo-1', {}, technician);

    expect(asset.status).toBe(AssetStatus.OPERATIONAL);
    expect(assetHistoryService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        previousStatus: AssetStatus.UNDER_MAINTENANCE,
        newStatus: AssetStatus.OPERATIONAL,
      }),
    );
  });

  describe('notification reconciliation on completion', () => {
    it('resolves the CRITICAL_ASSET notification once the asset is no longer critical', async () => {
      asset.status = AssetStatus.CRITICAL;

      await service.complete('wo-1', {}, technician);

      expect(notificationsService.resolveActive).toHaveBeenCalledWith(
        manager,
        'CRITICAL_ASSET',
        'Asset',
        'asset-1',
      );
    });

    it('also clears the alert of a DECOMMISSIONED asset (it is not critical)', async () => {
      asset.status = AssetStatus.DECOMMISSIONED;

      await service.complete('wo-1', {}, technician);

      expect(notificationsService.resolveActive).toHaveBeenCalledWith(
        manager,
        'CRITICAL_ASSET',
        'Asset',
        'asset-1',
      );
    });

    it('resolves the OVERDUE_MAINTENANCE notification of the completed plan only', async () => {
      await service.complete('wo-1', {}, technician);

      expect(notificationsService.resolveActive).toHaveBeenCalledWith(
        manager,
        'OVERDUE_MAINTENANCE',
        'MaintenancePlan',
        'plan-1',
      );
      expect(notificationsService.resolveActive).toHaveBeenCalledTimes(2);
    });

    it('does not touch overdue notifications when the work order has no plan', async () => {
      workOrder.maintenancePlanId = null;

      await service.complete('wo-1', {}, technician);

      expect(notificationsService.resolveActive).not.toHaveBeenCalledWith(
        manager,
        'OVERDUE_MAINTENANCE',
        expect.anything(),
        expect.anything(),
      );
    });

    it('locks the maintenance plan row while completing it', async () => {
      await service.complete('wo-1', {}, technician);

      expect(manager.findOne).toHaveBeenCalledWith(
        MaintenancePlan,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('rolls back everything (error propagates) when reconciliation fails', async () => {
      notificationsService.resolveActive.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.complete('wo-1', {}, technician)).rejects.toThrow(
        'db down',
      );
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  it('allows a supervisor who is not the assignee to complete it', async () => {
    workOrder.assignedToUserId = 'someone-else';

    await expect(
      service.complete('wo-1', {}, supervisor),
    ).resolves.toBeDefined();
  });

  describe('concurrency safety', () => {
    it('reads the work order under a pessimistic_write row lock', async () => {
      await service.complete('wo-1', {}, technician);

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(
        WorkOrder,
        'workOrder',
      );
      expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(lockQb.where).toHaveBeenCalledWith('workOrder.id = :id', {
        id: 'wo-1',
      });
    });

    it('locks the work order BEFORE consuming any spare part (fixed lock order)', async () => {
      inventoryService.consume.mockResolvedValue({
        sparePart: { id: 'part-1', sku: 'SKU-1', unitCost: 1 },
        transaction: { id: 'txn-1' },
      });

      await service.complete(
        'wo-1',
        { parts: [{ sparePartId: 'part-1', quantityUsed: 1 }] },
        technician,
      );

      const lockOrder = lockQb.getOne.mock.invocationCallOrder[0];
      const consumeOrder = inventoryService.consume.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(consumeOrder);
    });

    it('rejects a second completion of an already COMPLETED work order without consuming stock', async () => {
      workOrder.status = WorkOrderStatus.COMPLETED;

      await expect(
        service.complete(
          'wo-1',
          { parts: [{ sparePartId: 'part-1', quantityUsed: 5 }] },
          technician,
        ),
      ).rejects.toThrow(ConflictException);

      expect(inventoryService.consume).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('reads the asset under a pessimistic_write lock, after the spare parts', async () => {
      inventoryService.consume.mockResolvedValue({
        sparePart: { id: 'part-1', sku: 'SKU-1', unitCost: 1 },
        transaction: { id: 'txn-1' },
      });

      await service.complete(
        'wo-1',
        { parts: [{ sparePartId: 'part-1', quantityUsed: 1 }] },
        technician,
      );

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(Asset, 'asset');
      expect(assetLockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(assetLockQb.where).toHaveBeenCalledWith('asset.id = :id', {
        id: 'asset-1',
      });
      expect(inventoryService.consume.mock.invocationCallOrder[0]).toBeLessThan(
        assetLockQb.getOne.mock.invocationCallOrder[0],
      );
    });

    it('throws NotFoundException when the asset no longer exists', async () => {
      assetLockQb.getOne.mockResolvedValue(null);

      await expect(service.complete('wo-1', {}, technician)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      ['assign', () => service.assign('wo-1', {}, technician)],
      ['start', () => service.start('wo-1', technician)],
      ['cancel', () => service.cancel('wo-1', supervisor)],
    ])(
      '%s also reads the work order under a pessimistic_write lock',
      async (_name, run) => {
        workOrder.status =
          _name === 'assign' ? WorkOrderStatus.OPEN : WorkOrderStatus.ASSIGNED;

        await run();

        expect(lockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
      },
    );
  });
  describe('assign ownership', () => {
    it('rejects a technician self-assigning a work order owned by another technician', async () => {
      workOrder.status = WorkOrderStatus.ASSIGNED;
      workOrder.assignedToUserId = 'tech-2';

      await expect(service.assign('wo-1', {}, technician)).rejects.toThrow(
        ForbiddenException,
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('lets the current assignee re-assign to themselves', async () => {
      workOrder.status = WorkOrderStatus.ASSIGNED;
      workOrder.assignedToUserId = 'tech-1';

      await expect(
        service.assign('wo-1', {}, technician),
      ).resolves.toMatchObject({ assignedToUserId: 'tech-1' });
    });

    it('lets a supervisor reassign a work order owned by a technician', async () => {
      workOrder.status = WorkOrderStatus.ASSIGNED;
      workOrder.assignedToUserId = 'tech-2';

      await expect(
        service.assign('wo-1', { assignedToUserId: 'tech-1' }, supervisor),
      ).resolves.toMatchObject({ assignedToUserId: 'tech-1' });
    });

    it('keeps a 409 for a non-assignable status even when owned by someone else', async () => {
      workOrder.status = WorkOrderStatus.IN_PROGRESS;
      workOrder.assignedToUserId = 'tech-2';

      await expect(service.assign('wo-1', {}, technician)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('assign target eligibility', () => {
    beforeEach(() => {
      workOrder.status = WorkOrderStatus.OPEN;
      workOrder.assignedToUserId = null;
    });

    it('throws NotFoundException for a nonexistent target user and writes nothing', async () => {
      await expect(
        service.assign('wo-1', { assignedToUserId: 'ghost' }, supervisor),
      ).rejects.toThrow(NotFoundException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rejects a deactivated target with 409', async () => {
      users['tech-2'] = makeUser('tech-2', [RoleName.TECHNICIAN], false);

      await expect(
        service.assign('wo-1', { assignedToUserId: 'tech-2' }, supervisor),
      ).rejects.toThrow(/deactivated/);
      await expect(
        service.assign('wo-1', { assignedToUserId: 'tech-2' }, supervisor),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(workOrder.status).toBe(WorkOrderStatus.OPEN);
    });

    it('rejects a VIEWER-only target with 409', async () => {
      users['viewer-1'] = makeUser('viewer-1', [RoleName.VIEWER]);

      await expect(
        service.assign('wo-1', { assignedToUserId: 'viewer-1' }, supervisor),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rejects a target with no roles at all', async () => {
      users['norole-1'] = makeUser('norole-1', []);

      await expect(
        service.assign('wo-1', { assignedToUserId: 'norole-1' }, supervisor),
      ).rejects.toThrow(ConflictException);
    });

    it.each([RoleName.ADMIN, RoleName.SUPERVISOR, RoleName.TECHNICIAN])(
      'accepts an active %s target',
      async (role) => {
        users['target'] = makeUser('target', [RoleName.VIEWER, role]);

        await expect(
          service.assign('wo-1', { assignedToUserId: 'target' }, supervisor),
        ).resolves.toMatchObject({
          status: WorkOrderStatus.ASSIGNED,
          assignedToUserId: 'target',
        });
      },
    );

    it('validates the caller as the target on self-assign too', async () => {
      users['tech-1'] = makeUser('tech-1', [RoleName.TECHNICIAN], false);

      await expect(service.assign('wo-1', {}, technician)).rejects.toThrow(
        ConflictException,
      );
    });

    it('keeps the 403 for a technician assigning to someone else, before any target check', async () => {
      await expect(
        service.assign('wo-1', { assignedToUserId: 'ghost' }, technician),
      ).rejects.toThrow(ForbiddenException);
    });

    it('locks the target user row (shared, users table only) BEFORE the work order', async () => {
      await service.assign('wo-1', { assignedToUserId: 'tech-2' }, supervisor);

      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { id: 'tech-2' },
        lock: { mode: 'pessimistic_read', tables: ['users'] },
      });
      const userLock = manager.findOne.mock.invocationCallOrder[0];
      const woLock = lockQb.getOne.mock.invocationCallOrder[0];
      expect(userLock).toBeLessThan(woLock);
    });

    it('records the new assignment in the audit log', async () => {
      await service.assign('wo-1', { assignedToUserId: 'tech-2' }, supervisor);

      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          action: 'ASSIGN',
          before: { status: WorkOrderStatus.OPEN, assignedToUserId: null },
          after: {
            status: WorkOrderStatus.ASSIGNED,
            assignedToUserId: 'tech-2',
          },
        }),
      );
    });
  });

  describe('reassigning started work', () => {
    it.each([WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.BLOCKED])(
      'lets a supervisor reassign a %s work order, keeping its status',
      async (status) => {
        workOrder.status = status;
        workOrder.assignedToUserId = null; // released on deactivation

        const result = await service.assign(
          'wo-1',
          { assignedToUserId: 'tech-2' },
          supervisor,
        );

        expect(result).toMatchObject({
          status,
          assignedToUserId: 'tech-2',
        });
        expect(auditService.record).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            action: 'ASSIGN',
            before: { status, assignedToUserId: null },
            after: { status, assignedToUserId: 'tech-2' },
          }),
        );
      },
    );

    it('lets an admin take over an IN_PROGRESS work order owned by someone else', async () => {
      const admin: RequestUser = {
        id: 'admin-1',
        email: 'admin@example.com',
        roles: [RoleName.ADMIN],
      };
      users['admin-1'] = makeUser('admin-1', [RoleName.ADMIN]);
      workOrder.status = WorkOrderStatus.IN_PROGRESS;
      workOrder.assignedToUserId = 'tech-2';

      await expect(service.assign('wo-1', {}, admin)).resolves.toMatchObject({
        status: WorkOrderStatus.IN_PROGRESS,
        assignedToUserId: 'admin-1',
      });
    });

    it.each([WorkOrderStatus.IN_PROGRESS, WorkOrderStatus.BLOCKED])(
      'still rejects a technician reassigning a %s work order',
      async (status) => {
        workOrder.status = status;
        workOrder.assignedToUserId = null;

        await expect(service.assign('wo-1', {}, technician)).rejects.toThrow(
          ConflictException,
        );
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it.each([WorkOrderStatus.COMPLETED, WorkOrderStatus.CANCELLED])(
      'still rejects reassigning a %s work order, even for a supervisor',
      async (status) => {
        workOrder.status = status;

        await expect(
          service.assign('wo-1', { assignedToUserId: 'tech-2' }, supervisor),
        ).rejects.toThrow(ConflictException);
      },
    );
  });

  describe('block', () => {
    it('blocks an IN_PROGRESS work order assigned to the technician, recording the reason', async () => {
      const result = await service.block(
        'wo-1',
        { reason: 'Waiting on replacement bearing from supplier' },
        technician,
      );

      expect(result.status).toBe(WorkOrderStatus.BLOCKED);
      expect(result.blockReason).toBe(
        'Waiting on replacement bearing from supplier',
      );
      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          entityType: 'WorkOrder',
          entityId: 'wo-1',
          action: 'BLOCK',
          after: expect.objectContaining({
            status: WorkOrderStatus.BLOCKED,
            blockReason: 'Waiting on replacement bearing from supplier',
          }),
        }),
      );
    });

    it('throws ForbiddenException for a technician who is not the assignee', async () => {
      const otherTech: RequestUser = {
        id: 'tech-2',
        email: 'other@example.com',
        roles: [RoleName.TECHNICIAN],
      };

      await expect(
        service.block('wo-1', { reason: 'Needs a part' }, otherTech),
      ).rejects.toThrow(ForbiddenException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('allows a supervisor who is not the assignee to block it', async () => {
      workOrder.assignedToUserId = 'someone-else';

      await expect(
        service.block('wo-1', { reason: 'Site access restricted' }, supervisor),
      ).resolves.toMatchObject({ status: WorkOrderStatus.BLOCKED });
    });

    it('throws ConflictException when the work order is not IN_PROGRESS', async () => {
      workOrder.status = WorkOrderStatus.OPEN;

      await expect(
        service.block('wo-1', { reason: 'Needs a part' }, technician),
      ).rejects.toThrow(ConflictException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('clears blockReason when the work order is restarted', async () => {
      workOrder.status = WorkOrderStatus.BLOCKED;
      workOrder.blockReason = 'Waiting on replacement bearing from supplier';

      const result = await service.start('wo-1', technician);

      expect(result.status).toBe(WorkOrderStatus.IN_PROGRESS);
      expect(result.blockReason).toBeNull();
    });
  });
});

describe('WorkOrdersService.create', () => {
  let service: WorkOrdersService;
  let manager: {
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let assetLockQb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let auditService: { record: jest.Mock };
  let asset: Asset;

  const actor: RequestUser = {
    id: 'super-1',
    email: 'super@example.com',
    roles: [RoleName.SUPERVISOR],
  };

  beforeEach(() => {
    asset = { id: 'asset-1', status: AssetStatus.OPERATIONAL } as Asset;
    assetLockQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => asset),
    };
    manager = {
      createQueryBuilder: jest.fn(() => assetLockQb),
      findOneBy: jest.fn(async () => null),
      create: jest.fn((_entity, plain) => plain),
      save: jest.fn(async (entity) => ({ ...entity, id: 'wo-new' })),
    };
    auditService = { record: jest.fn(async () => ({})) };
    service = new WorkOrdersService(
      {} as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      auditService as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('rejects creating a work order for a DECOMMISSIONED asset', async () => {
    asset.status = AssetStatus.DECOMMISSIONED;

    await expect(
      service.create({ assetId: 'asset-1', description: 'x' } as any, actor),
    ).rejects.toThrow(ConflictException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the asset does not exist', async () => {
    assetLockQb.getOne.mockResolvedValue(null);

    await expect(
      service.create({ assetId: 'missing', description: 'x' } as any, actor),
    ).rejects.toThrow(NotFoundException);
  });

  it('locks the asset and creates the work order for a non-decommissioned asset', async () => {
    const result = await service.create(
      { assetId: 'asset-1', description: 'x' } as any,
      actor,
    );

    expect(assetLockQb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(result.id).toBe('wo-new');
    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ action: 'CREATE' }),
    );
  });
});

describe('WorkOrdersService.cancel', () => {
  let service: WorkOrdersService;
  let manager: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let woQb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let assetQb: { setLock: jest.Mock; where: jest.Mock; getOne: jest.Mock };
  let auditService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };
  let workOrder: WorkOrder;
  let asset: Asset;

  const actor: RequestUser = {
    id: 'super-1',
    email: 'super@example.com',
    roles: [RoleName.SUPERVISOR],
  };

  beforeEach(() => {
    workOrder = {
      id: 'wo-1',
      assetId: 'asset-1',
      status: WorkOrderStatus.OPEN,
    } as WorkOrder;
    asset = { id: 'asset-1', status: AssetStatus.CRITICAL } as Asset;
    woQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => workOrder),
    };
    assetQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => asset),
    };
    manager = {
      createQueryBuilder: jest.fn((entity: unknown) =>
        entity === Asset ? assetQb : woQb,
      ),
      save: jest.fn(async (entity) => entity),
    };
    auditService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };
    service = new WorkOrdersService(
      {} as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      auditService as any,
      {} as any,
      {} as any,
      notificationsService as any,
    );
  });

  it('keeps the CRITICAL_ASSET notification when the asset is still critical', async () => {
    const result = await service.cancel('wo-1', actor);

    expect(result.status).toBe(WorkOrderStatus.CANCELLED);
    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('locks the asset and resolves the notification only when the asset is no longer critical', async () => {
    asset.status = AssetStatus.OPERATIONAL;

    await service.cancel('wo-1', actor);

    expect(assetQb.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(notificationsService.resolveActive).toHaveBeenCalledWith(
      manager,
      'CRITICAL_ASSET',
      'Asset',
      'asset-1',
    );
  });

  it('still cancels and audits normally', async () => {
    await service.cancel('wo-1', actor);

    expect(auditService.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ action: 'CANCEL' }),
    );
  });

  it('rolls back (error propagates, no audit) when reconciliation fails', async () => {
    asset.status = AssetStatus.OPERATIONAL;
    notificationsService.resolveActive.mockRejectedValue(new Error('db down'));

    await expect(service.cancel('wo-1', actor)).rejects.toThrow('db down');
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
