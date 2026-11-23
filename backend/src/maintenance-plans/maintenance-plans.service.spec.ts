import { ConflictException, NotFoundException } from '@nestjs/common';
import { Asset, AssetStatus } from '../assets/entities/asset.entity';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { RoleName } from '../users/entities/role.entity';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { MaintenancePlansService } from './maintenance-plans.service';

describe('MaintenancePlansService notification reconciliation', () => {
  let service: MaintenancePlansService;
  let manager: { findOne: jest.Mock; save: jest.Mock; remove: jest.Mock };
  let auditService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };
  let plan: MaintenancePlan;

  const actor: RequestUser = {
    id: 'user-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMIN],
  };
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    plan = {
      id: 'plan-1',
      assetId: 'asset-1',
      name: 'Lubrication',
      intervalDays: 30,
      active: true,
      nextDueAt: new Date(Date.now() - DAY), // overdue
    } as MaintenancePlan;
    manager = {
      findOne: jest.fn(async () => plan),
      save: jest.fn(async (entity) => entity),
      remove: jest.fn(async (entity) => entity),
    };
    auditService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };
    service = new MaintenancePlansService(
      {} as any,
      {} as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      auditService as any,
      notificationsService as any,
    );
  });

  const expectResolved = () =>
    expect(notificationsService.resolveActive).toHaveBeenCalledWith(
      manager,
      'OVERDUE_MAINTENANCE',
      'MaintenancePlan',
      'plan-1',
    );

  it('resolves OVERDUE_MAINTENANCE when the plan is deactivated', async () => {
    await service.update('plan-1', { active: false } as any, actor);

    expectResolved();
  });

  it('resolves OVERDUE_MAINTENANCE when the next due date is moved into the future', async () => {
    await service.update(
      'plan-1',
      { nextDueAt: new Date(Date.now() + 5 * DAY).toISOString() } as any,
      actor,
    );

    expectResolved();
  });

  it('keeps the notification while the plan is still active and overdue', async () => {
    await service.update('plan-1', { active: true } as any, actor);

    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('does not reconcile for updates that touch neither activity nor due date', async () => {
    await service.update('plan-1', { name: 'Renamed' } as any, actor);

    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('resolves OVERDUE_MAINTENANCE when the plan is deleted, for that plan only', async () => {
    await service.remove('plan-1', actor);

    expectResolved();
    expect(notificationsService.resolveActive).toHaveBeenCalledTimes(1);
  });

  it('locks the plan row so it serializes with the scheduler', async () => {
    await service.update('plan-1', { active: false } as any, actor);

    expect(manager.findOne).toHaveBeenCalledWith(
      MaintenancePlan,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('does nothing for a missing plan', async () => {
    manager.findOne.mockResolvedValue(null);

    await expect(service.remove('nope', actor)).rejects.toThrow(
      NotFoundException,
    );
    expect(notificationsService.resolveActive).not.toHaveBeenCalled();
  });

  it('propagates a reconciliation failure so the transaction aborts', async () => {
    notificationsService.resolveActive.mockRejectedValue(new Error('db down'));

    await expect(service.remove('plan-1', actor)).rejects.toThrow('db down');
    expect(auditService.record).not.toHaveBeenCalled();
  });
});

describe('MaintenancePlansService and decommissioned assets (BL-03)', () => {
  let service: MaintenancePlansService;
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let planRepo: { createQueryBuilder: jest.Mock };
  let qb: Record<string, jest.Mock>;
  let auditService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };

  const actor: RequestUser = {
    id: 'user-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMIN],
  };

  beforeEach(() => {
    qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
      getManyAndCount: jest.fn(async () => [[], 0]),
    };
    planRepo = { createQueryBuilder: jest.fn(() => qb) };
    manager = {
      find: jest.fn(async () => []),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((_entity, plain) => plain),
      save: jest.fn(async (entity) => ({ id: 'plan-new', ...entity })),
    };
    auditService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };
    service = new MaintenancePlansService(
      planRepo as any,
      {} as any,
      { transaction: jest.fn((cb) => cb(manager)) } as any,
      auditService as any,
      notificationsService as any,
    );
  });

  describe('due queries', () => {
    const excludesDecommissioned = () => {
      expect(qb.innerJoin).toHaveBeenCalledWith('plan.asset', 'asset');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'asset.status <> :decommissioned',
        {
          decommissioned: AssetStatus.DECOMMISSIONED,
        },
      );
    };

    it('findAllDue (used by the cron) excludes plans of decommissioned assets', async () => {
      await service.findAllDue();

      excludesDecommissioned();
      expect(qb.where).toHaveBeenCalledWith('plan.active = :active', {
        active: true,
      });
    });

    it('findDue (dashboard tile, Due view) excludes plans of decommissioned assets', async () => {
      await service.findDue({ page: 1, limit: 20 } as any);

      excludesDecommissioned();
    });
  });

  describe('create', () => {
    const dto = { assetId: 'asset-1', name: 'Lube', intervalDays: 30 } as any;

    it('rejects a plan for a DECOMMISSIONED asset with 409 and writes nothing', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.DECOMMISSIONED,
      });

      await expect(service.create(dto, actor)).rejects.toThrow(
        ConflictException,
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rejects an inactive plan for a DECOMMISSIONED asset too', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.DECOMMISSIONED,
      });

      await expect(
        service.create({ ...dto, active: false }, actor),
      ).rejects.toThrow(ConflictException);
    });

    it('locks the asset row so a concurrent decommission cannot slip in', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
      });

      await service.create(dto, actor);

      expect(manager.findOne).toHaveBeenCalledWith(
        Asset,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(manager.save).toHaveBeenCalled();
    });

    it('still throws NotFoundException for an unknown asset', async () => {
      manager.findOne.mockResolvedValue(null);

      await expect(service.create(dto, actor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    let plan: MaintenancePlan;

    beforeEach(() => {
      plan = {
        id: 'plan-1',
        assetId: 'asset-1',
        name: 'Lube',
        intervalDays: 30,
        active: false,
        nextDueAt: new Date(Date.now() - 1000),
      } as MaintenancePlan;
      manager.findOne.mockResolvedValue(plan);
    });

    it('refuses to reactivate a plan of a DECOMMISSIONED asset', async () => {
      manager.findOneBy.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.DECOMMISSIONED,
      });

      await expect(
        service.update('plan-1', { active: true } as any, actor),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(plan.active).toBe(false);
    });

    it('reactivates a plan of an in-service asset', async () => {
      manager.findOneBy.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
      });

      await service.update('plan-1', { active: true } as any, actor);

      expect(plan.active).toBe(true);
    });

    it('still lets a plan of a decommissioned asset be renamed or deactivated', async () => {
      plan.active = true;
      manager.findOneBy.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.DECOMMISSIONED,
      });

      await service.update(
        'plan-1',
        { name: 'Renamed', active: false } as any,
        actor,
      );

      expect(plan.name).toBe('Renamed');
      expect(plan.active).toBe(false);
    });
  });

  describe('deactivateForAsset', () => {
    const makePlan = (id: string, active: boolean) =>
      ({ id, assetId: 'asset-1', active }) as MaintenancePlan;

    it('deactivates active plans, audits each and resolves their OVERDUE alerts', async () => {
      const a = makePlan('plan-a', true);
      const b = makePlan('plan-b', true);
      manager.find.mockResolvedValue([a, b]);

      const count = await service.deactivateForAsset(
        manager as any,
        'asset-1',
        actor,
        'asset-decommission',
      );

      expect(count).toBe(2);
      expect(a.active).toBe(false);
      expect(b.active).toBe(false);
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          actorUserId: 'user-1',
          entityType: 'MaintenancePlan',
          entityId: 'plan-a',
          action: 'UPDATE',
          before: { active: true },
          after: { active: false },
          source: 'asset-decommission',
        }),
      );
      for (const id of ['plan-a', 'plan-b']) {
        expect(notificationsService.resolveActive).toHaveBeenCalledWith(
          manager,
          'OVERDUE_MAINTENANCE',
          'MaintenancePlan',
          id,
        );
      }
    });

    it('resolves stale alerts of already-inactive plans without rewriting them', async () => {
      const inactive = makePlan('plan-c', false);
      manager.find.mockResolvedValue([inactive]);

      const count = await service.deactivateForAsset(
        manager as any,
        'asset-1',
        actor,
        'asset-decommission',
      );

      expect(count).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(notificationsService.resolveActive).toHaveBeenCalledWith(
        manager,
        'OVERDUE_MAINTENANCE',
        'MaintenancePlan',
        'plan-c',
      );
    });

    it("only loads this asset's plans, under a row lock, in a stable order", async () => {
      await service.deactivateForAsset(
        manager as any,
        'asset-1',
        null,
        'asset-decommission',
      );

      expect(manager.find).toHaveBeenCalledWith(MaintenancePlan, {
        where: { assetId: 'asset-1' },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('records a null actor for system-initiated deactivation', async () => {
      manager.find.mockResolvedValue([makePlan('plan-a', true)]);

      await service.deactivateForAsset(
        manager as any,
        'asset-1',
        null,
        'asset-decommission',
      );

      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ actorUserId: null }),
      );
    });
  });
});
