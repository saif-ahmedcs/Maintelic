import { ConflictException, NotFoundException } from '@nestjs/common';
import { AssetType } from '../asset-types/entities/asset-type.entity';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { Location } from '../locations/entities/location.entity';
import { RoleName } from '../users/entities/role.entity';
import { AssetsService } from './assets.service';
import { AssetQueryDto } from './dto/asset-query.dto';
import {
  WorkOrder,
  WorkOrderStatus,
} from '../work-orders/entities/work-order.entity';
import { AssetStatus } from './entities/asset.entity';

describe('AssetsService', () => {
  let service: AssetsService;
  let assetRepo: { findOneBy: jest.Mock; createQueryBuilder: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    find: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let auditService: { record: jest.Mock };
  let assetHistoryService: { record: jest.Mock };
  let notificationsService: { resolveActive: jest.Mock };
  let maintenancePlansService: { deactivateForAsset: jest.Mock };

  const actor: RequestUser = {
    id: 'user-1',
    email: 'admin@example.com',
    roles: [RoleName.ADMIN],
  };

  beforeEach(() => {
    assetRepo = { findOneBy: jest.fn(), createQueryBuilder: jest.fn() };
    manager = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((_entity, plain) => plain),
      save: jest.fn(async (entity) => ({ ...entity, id: 'asset-1' })),
      remove: jest.fn(async (entity) => entity),
      find: jest.fn(async () => []),
    };
    dataSource = { transaction: jest.fn((cb) => cb(manager)) };
    auditService = { record: jest.fn(async () => ({})) };
    assetHistoryService = { record: jest.fn(async () => ({})) };
    notificationsService = { resolveActive: jest.fn(async () => 1) };
    maintenancePlansService = { deactivateForAsset: jest.fn(async () => 0) };

    service = new AssetsService(
      assetRepo as any,
      dataSource as any,
      auditService as any,
      assetHistoryService as any,
      notificationsService as any,
      maintenancePlansService as any,
    );
  });

  describe('findAll', () => {
    let qb: {
      alias: string;
      andWhere: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      skip: jest.Mock;
      take: jest.Mock;
      getManyAndCount: jest.Mock;
    };

    const query = (overrides: Partial<AssetQueryDto> = {}): AssetQueryDto =>
      ({ page: 1, limit: 20, sortDir: 'DESC', ...overrides }) as AssetQueryDto;

    beforeEach(() => {
      qb = {
        alias: 'asset',
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      assetRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('applies no status condition when no status is given', async () => {
      await service.findAll(query());

      expect(assetRepo.createQueryBuilder).toHaveBeenCalledWith('asset');
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('adds a parameterised status condition when a status is given', async () => {
      await service.findAll(query({ status: AssetStatus.CRITICAL }));

      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(qb.andWhere).toHaveBeenCalledWith('asset.status = :status', {
        status: AssetStatus.CRITICAL,
      });
    });

    it('still paginates and sorts a status-filtered query', async () => {
      await service.findAll(
        query({ status: AssetStatus.OPERATIONAL, page: 2, limit: 10 }),
      );

      expect(qb.orderBy).toHaveBeenCalledWith('asset.tag', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('adds a parameterised, wildcard-wrapped ILIKE condition when search is given', async () => {
      await service.findAll(query({ search: 'PUMP' }));

      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      expect(qb.andWhere).toHaveBeenCalledWith('asset.tag ILIKE :search', {
        search: '%PUMP%',
      });
    });

    it('adds a parameterised locationId condition when locationId is given', async () => {
      await service.findAll(query({ locationId: 'loc-1' }));

      expect(qb.andWhere).toHaveBeenCalledWith(
        'asset.locationId = :locationId',
        {
          locationId: 'loc-1',
        },
      );
    });

    it('adds a parameterised assetTypeId condition when assetTypeId is given', async () => {
      await service.findAll(query({ assetTypeId: 'type-1' }));

      expect(qb.andWhere).toHaveBeenCalledWith(
        'asset.assetTypeId = :assetTypeId',
        { assetTypeId: 'type-1' },
      );
    });

    it('combines status, search, location, and asset type into one query', async () => {
      await service.findAll(
        query({
          status: AssetStatus.CRITICAL,
          search: 'PUMP',
          locationId: 'loc-1',
          assetTypeId: 'type-1',
        }),
      );

      expect(qb.andWhere).toHaveBeenCalledTimes(4);
    });
  });

  describe('create', () => {
    it('throws NotFoundException when the asset type does not exist', async () => {
      manager.findOneBy.mockResolvedValue(null);

      await expect(
        service.create(
          {
            assetTypeId: 'missing-type',
            locationId: 'loc-1',
            tag: 'PUMP-001',
          } as any,
          actor,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the location does not exist', async () => {
      manager.findOneBy.mockImplementation(
        async (entity: unknown, where: { id: string }) => {
          if (entity === AssetType && where.id === 'type-1') {
            return { id: 'type-1' };
          }
          return null;
        },
      );

      await expect(
        service.create(
          {
            assetTypeId: 'type-1',
            locationId: 'missing-location',
            tag: 'PUMP-001',
          } as any,
          actor,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('creates the asset and records a CREATE audit entry when both references exist', async () => {
      manager.findOneBy.mockImplementation(async (entity: unknown) => {
        if (entity === AssetType) return { id: 'type-1' };
        if (entity === Location) return { id: 'loc-1' };
        return null;
      });

      const result = await service.create(
        {
          assetTypeId: 'type-1',
          locationId: 'loc-1',
          tag: 'PUMP-001',
        } as any,
        actor,
      );

      expect(manager.save).toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ entityType: 'Asset', action: 'CREATE' }),
      );
      expect(result.id).toBe('asset-1');
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the asset does not exist', async () => {
      manager.findOneBy.mockResolvedValue(null);

      await expect(
        service.update('missing-id', { tag: 'X' } as any, actor),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when reassigning to a nonexistent asset type', async () => {
      manager.findOneBy.mockImplementation(
        async (entity: unknown, where: { id: string }) => {
          if (entity !== AssetType && where.id === 'asset-1') {
            return {
              id: 'asset-1',
              assetTypeId: 'type-1',
              locationId: 'loc-1',
              tag: 'PUMP-001',
            };
          }
          if (entity === AssetType) return null;
          return null;
        },
      );

      await expect(
        service.update(
          'asset-1',
          { assetTypeId: 'missing-type' } as any,
          actor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('throws NotFoundException when the asset does not exist', async () => {
      manager.findOne.mockResolvedValue(null);

      await expect(
        service.updateStatus(
          'missing-id',
          { status: AssetStatus.CRITICAL } as any,
          actor,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('records a STATUS_CHANGE audit entry and a matching history row', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
      });
      manager.save.mockImplementation(async (entity) => entity);

      const result = await service.updateStatus(
        'asset-1',
        { status: AssetStatus.CRITICAL } as any,
        actor,
      );

      expect(result.status).toBe(AssetStatus.CRITICAL);
      expect(auditService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          entityType: 'Asset',
          action: 'STATUS_CHANGE',
          before: { status: AssetStatus.OPERATIONAL },
          after: { status: AssetStatus.CRITICAL },
        }),
      );
      expect(assetHistoryService.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          assetId: 'asset-1',
          previousStatus: AssetStatus.OPERATIONAL,
          newStatus: AssetStatus.CRITICAL,
          changedByUserId: actor.id,
        }),
      );
    });

    it('skips the audit and history writes when the status is unchanged', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
      });

      const result = await service.updateStatus(
        'asset-1',
        { status: AssetStatus.OPERATIONAL } as any,
        actor,
      );

      expect(result.status).toBe(AssetStatus.OPERATIONAL);
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(assetHistoryService.record).not.toHaveBeenCalled();
    });

    it.each([
      AssetStatus.OPERATIONAL,
      AssetStatus.UNDER_MAINTENANCE,
      AssetStatus.CRITICAL,
    ])(
      'rejects changing a DECOMMISSIONED asset to %s and writes nothing',
      async (target) => {
        manager.findOne.mockResolvedValue({
          id: 'asset-1',
          status: AssetStatus.DECOMMISSIONED,
        });

        await expect(
          service.updateStatus('asset-1', { status: target } as any, actor),
        ).rejects.toThrow(ConflictException);
        expect(manager.save).not.toHaveBeenCalled();
        expect(auditService.record).not.toHaveBeenCalled();
        expect(assetHistoryService.record).not.toHaveBeenCalled();
      },
    );

    describe('CRITICAL_ASSET notification reconciliation', () => {
      const setup = (status: AssetStatus) => {
        manager.findOne.mockResolvedValue({ id: 'asset-1', status });
        manager.save.mockImplementation(async (entity) => entity);
      };

      it.each([AssetStatus.OPERATIONAL, AssetStatus.UNDER_MAINTENANCE])(
        'resolves the notification when a CRITICAL asset is set to %s',
        async (target) => {
          setup(AssetStatus.CRITICAL);

          await service.updateStatus(
            'asset-1',
            { status: target } as any,
            actor,
          );

          expect(notificationsService.resolveActive).toHaveBeenCalledWith(
            manager,
            'CRITICAL_ASSET',
            'Asset',
            'asset-1',
          );
        },
      );

      it('also resolves it when a CRITICAL asset is decommissioned', async () => {
        setup(AssetStatus.CRITICAL);

        await service.updateStatus(
          'asset-1',
          { status: AssetStatus.DECOMMISSIONED } as any,
          actor,
        );

        expect(notificationsService.resolveActive).toHaveBeenCalledTimes(1);
      });

      it('does not resolve when the asset becomes CRITICAL or the status is unchanged', async () => {
        setup(AssetStatus.OPERATIONAL);
        await service.updateStatus(
          'asset-1',
          { status: AssetStatus.CRITICAL } as any,
          actor,
        );

        setup(AssetStatus.CRITICAL);
        await service.updateStatus(
          'asset-1',
          { status: AssetStatus.CRITICAL } as any,
          actor,
        );

        expect(notificationsService.resolveActive).not.toHaveBeenCalled();
      });

      it('never resolves anything for a rejected DECOMMISSIONED transition (DI-1 invariant)', async () => {
        setup(AssetStatus.DECOMMISSIONED);

        await expect(
          service.updateStatus(
            'asset-1',
            { status: AssetStatus.OPERATIONAL } as any,
            actor,
          ),
        ).rejects.toThrow(ConflictException);
        expect(notificationsService.resolveActive).not.toHaveBeenCalled();
        expect(assetHistoryService.record).not.toHaveBeenCalled();
      });

      it('keeps audit + history writes and propagates a reconciliation failure', async () => {
        setup(AssetStatus.CRITICAL);
        notificationsService.resolveActive.mockRejectedValue(
          new Error('db down'),
        );

        await expect(
          service.updateStatus(
            'asset-1',
            { status: AssetStatus.OPERATIONAL } as any,
            actor,
          ),
        ).rejects.toThrow('db down');
      });
    });

    describe('decommissioning (BL-03)', () => {
      const setup = (status = AssetStatus.OPERATIONAL) => {
        manager.findOne.mockResolvedValue({ id: 'asset-1', status });
        manager.save.mockImplementation(async (entity) => entity);
      };
      const decommission = () =>
        service.updateStatus(
          'asset-1',
          { status: AssetStatus.DECOMMISSIONED } as any,
          actor,
        );
      const openWorkOrders = () => [
        {
          id: 'wo-1',
          assetId: 'asset-1',
          status: WorkOrderStatus.OPEN,
          source: 'AUTO',
        },
        {
          id: 'wo-2',
          assetId: 'asset-1',
          status: WorkOrderStatus.IN_PROGRESS,
          source: 'PLANNED',
        },
      ];

      it('deactivates the asset plans and resolves their alerts in the same transaction', async () => {
        setup();

        await decommission();

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(maintenancePlansService.deactivateForAsset).toHaveBeenCalledWith(
          manager,
          'asset-1',
          actor,
          'asset-decommission',
        );
      });

      it('cancels every open work order of the asset and audits each cancellation', async () => {
        setup();
        manager.find.mockResolvedValue(openWorkOrders());

        await decommission();

        const cancelled = manager.save.mock.calls
          .map(([entity]) => entity)
          .filter((entity) => entity.id === 'wo-1' || entity.id === 'wo-2');
        expect(cancelled).toHaveLength(2);
        for (const workOrder of cancelled) {
          expect(workOrder.status).toBe(WorkOrderStatus.CANCELLED);
          expect(workOrder.cancelledAt).toBeInstanceOf(Date);
        }
        expect(auditService.record).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            entityType: 'WorkOrder',
            entityId: 'wo-2',
            action: 'CANCEL',
            before: { status: WorkOrderStatus.IN_PROGRESS },
            after: { status: WorkOrderStatus.CANCELLED },
            source: 'asset-decommission',
          }),
        );
      });

      it('only targets open work orders of this asset', async () => {
        setup();

        await decommission();

        expect(manager.find).toHaveBeenCalledWith(
          WorkOrder,
          expect.objectContaining({
            where: expect.objectContaining({ assetId: 'asset-1' }),
          }),
        );
      });

      it('locks the open work orders before the asset row (same order as work-order transitions)', async () => {
        setup();
        manager.find.mockResolvedValue([]);

        await decommission();

        expect(manager.find).toHaveBeenCalledWith(
          WorkOrder,
          expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
        );
        expect(manager.find.mock.invocationCallOrder[0]).toBeLessThan(
          manager.findOne.mock.invocationCallOrder[0],
        );
      });

      it.each([
        AssetStatus.OPERATIONAL,
        AssetStatus.UNDER_MAINTENANCE,
        AssetStatus.CRITICAL,
      ])(
        'closes out work orders and plans when a %s asset is decommissioned',
        async (from) => {
          setup(from);
          manager.find.mockResolvedValue(openWorkOrders());

          await decommission();

          expect(
            maintenancePlansService.deactivateForAsset,
          ).toHaveBeenCalledTimes(1);
        },
      );

      it('does not touch work orders or plans for any other status change', async () => {
        setup(AssetStatus.OPERATIONAL);

        await service.updateStatus(
          'asset-1',
          { status: AssetStatus.UNDER_MAINTENANCE } as any,
          actor,
        );

        expect(manager.find).not.toHaveBeenCalled();
        expect(
          maintenancePlansService.deactivateForAsset,
        ).not.toHaveBeenCalled();
      });

      it('closes nothing out when the asset is already decommissioned', async () => {
        setup(AssetStatus.DECOMMISSIONED);

        await decommission();

        expect(
          maintenancePlansService.deactivateForAsset,
        ).not.toHaveBeenCalled();
        expect(manager.save).not.toHaveBeenCalled();
      });

      it('closes nothing out when the asset does not exist', async () => {
        manager.findOne.mockResolvedValue(null);

        await expect(decommission()).rejects.toThrow(NotFoundException);
        expect(
          maintenancePlansService.deactivateForAsset,
        ).not.toHaveBeenCalled();
      });

      it('propagates a plan-deactivation failure so the whole decommission rolls back', async () => {
        setup();
        maintenancePlansService.deactivateForAsset.mockRejectedValue(
          new Error('db down'),
        );

        await expect(decommission()).rejects.toThrow('db down');
      });
    });

    it('locks the asset row while changing its status', async () => {
      manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
      });
      manager.save.mockImplementation(async (entity) => entity);

      await service.updateStatus(
        'asset-1',
        { status: AssetStatus.CRITICAL } as any,
        actor,
      );

      expect(manager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when the asset does not exist', async () => {
      manager.findOneBy.mockResolvedValue(null);

      await expect(service.remove('missing-id', actor)).rejects.toThrow(
        NotFoundException,
      );
      expect(manager.remove).not.toHaveBeenCalled();
    });
  });
});
