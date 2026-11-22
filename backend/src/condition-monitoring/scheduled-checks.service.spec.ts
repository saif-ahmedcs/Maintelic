import { In } from 'typeorm';
import { SparePart } from '../inventory/entities/spare-part.entity';
import { InventoryService } from '../inventory/inventory.service';
import { MaintenancePlan } from '../maintenance-plans/entities/maintenance-plan.entity';
import { MaintenancePlansService } from '../maintenance-plans/maintenance-plans.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { ACTIVE_WORK_ORDER_STATUSES } from './condition-monitoring.service';
import { ScheduledChecksService } from './scheduled-checks.service';
import { Logger } from '@nestjs/common';

describe('ScheduledChecksService', () => {
  let service: ScheduledChecksService;
  let maintenancePlansService: { findAllDue: jest.Mock };
  let inventoryService: { findAllLowStock: jest.Mock };
  let notificationsService: {
    hasActiveNotification: jest.Mock;
    record: jest.Mock;
  };
  let dataSource: { manager: { findOne: jest.Mock }; transaction: jest.Mock };
  let txManager: { createQueryBuilder: jest.Mock; exists: jest.Mock };
  let txState: { plan: any; part: any };
  let workOrderRepo: { exists: jest.Mock };
  let aiInsightsService: { generate: jest.Mock };

  const plan = {
    id: 'plan-1',
    assetId: 'asset-1',
    name: 'Quarterly lubrication',
    intervalDays: 90,
    nextDueAt: new Date('2026-09-20T00:00:00.000Z'),
  };

  const part = {
    id: 'part-1',
    sku: 'BRG-6205',
    name: 'Bearing 6205',
    quantityOnHand: 2,
    reorderThreshold: 5,
  };

  beforeEach(() => {
    maintenancePlansService = { findAllDue: jest.fn() };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    inventoryService = { findAllLowStock: jest.fn() };
    notificationsService = {
      hasActiveNotification: jest.fn(),
      record: jest.fn(async () => ({})),
    };
    txState = {
      plan: { ...plan, active: true },
      part: { ...part },
    };
    txManager = {
      createQueryBuilder: jest.fn((entity: unknown) => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () =>
          entity === MaintenancePlan ? txState.plan : txState.part,
        ),
      })),
      exists: jest.fn(async () => false),
    };
    dataSource = {
      manager: { findOne: jest.fn().mockResolvedValue(null) },
      transaction: jest.fn((cb: any) => cb(txManager)),
    };
    workOrderRepo = { exists: jest.fn() };
    aiInsightsService = { generate: jest.fn().mockResolvedValue(null) };

    service = new ScheduledChecksService(
      maintenancePlansService as any,
      inventoryService as any,
      notificationsService as any,
      dataSource as any,
      workOrderRepo as any,
      aiInsightsService as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkOverdueMaintenance', () => {
    it('does nothing when no plans are due', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([]);

      await service.checkOverdueMaintenance();

      expect(workOrderRepo.exists).not.toHaveBeenCalled();
      expect(notificationsService.hasActiveNotification).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('creates an OVERDUE_MAINTENANCE notification for a due plan with no open work order and no existing notification', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(false);
      notificationsService.hasActiveNotification.mockResolvedValue(false);

      await service.checkOverdueMaintenance();

      expect(workOrderRepo.exists).toHaveBeenCalledWith({
        where: {
          maintenancePlanId: plan.id,
          status: In(ACTIVE_WORK_ORDER_STATUSES),
        },
      });
      expect(notificationsService.hasActiveNotification).toHaveBeenCalledWith(
        NotificationType.OVERDUE_MAINTENANCE,
        'MaintenancePlan',
        plan.id,
      );
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          type: NotificationType.OVERDUE_MAINTENANCE,
          relatedEntityType: 'MaintenancePlan',
          relatedEntityId: plan.id,
          message: expect.stringContaining(plan.name),
        }),
      );
    });

    it('skips a due plan that already has an open work order, without checking notifications', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(true);

      await service.checkOverdueMaintenance();

      expect(notificationsService.hasActiveNotification).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('skips a due plan that already has an active notification (no re-notify every hour)', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(false);
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.checkOverdueMaintenance();

      expect(notificationsService.record).not.toHaveBeenCalled();
    });
    it('attaches the AI note to the notification, building context from the plan and its asset', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(false);
      notificationsService.hasActiveNotification.mockResolvedValue(false);
      dataSource.manager.findOne.mockResolvedValue({
        tag: 'PUMP-01',
        criticality: 'HIGH',
        assetType: { name: 'Pump' },
      });
      aiInsightsService.generate.mockResolvedValue(
        'Possibly worn lubricant. Check the oil level first.',
      );

      await service.checkOverdueMaintenance();

      expect(aiInsightsService.generate).toHaveBeenCalledWith({
        kind: 'OVERDUE_MAINTENANCE',
        asset: { tag: 'PUMP-01', typeName: 'Pump', criticality: 'HIGH' },
        planName: plan.name,
        intervalDays: plan.intervalDays,
        dueAt: plan.nextDueAt,
      });
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          aiNote: 'Possibly worn lubricant. Check the oil level first.',
        }),
      );
    });

    it('still creates the notification with aiNote null when the AI returns nothing and the asset is missing', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(false);
      notificationsService.hasActiveNotification.mockResolvedValue(false);
      dataSource.manager.findOne.mockResolvedValue(null);
      aiInsightsService.generate.mockResolvedValue(null);

      await service.checkOverdueMaintenance();

      expect(aiInsightsService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'OVERDUE_MAINTENANCE', asset: null }),
      );
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          type: NotificationType.OVERDUE_MAINTENANCE,
          aiNote: null,
        }),
      );
    });

    it('does not call the AI for a plan that is skipped', async () => {
      maintenancePlansService.findAllDue.mockResolvedValue([plan]);
      workOrderRepo.exists.mockResolvedValue(false);
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.checkOverdueMaintenance();

      expect(aiInsightsService.generate).not.toHaveBeenCalled();
    });
  });

  describe('checkLowStock', () => {
    it('does nothing when no parts are low on stock', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([]);

      await service.checkLowStock();

      expect(notificationsService.hasActiveNotification).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('creates a LOW_STOCK notification for a part at/below threshold with no existing notification', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([part]);
      notificationsService.hasActiveNotification.mockResolvedValue(false);

      await service.checkLowStock();

      expect(notificationsService.hasActiveNotification).toHaveBeenCalledWith(
        NotificationType.LOW_STOCK,
        'SparePart',
        part.id,
      );
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          type: NotificationType.LOW_STOCK,
          relatedEntityType: 'SparePart',
          relatedEntityId: part.id,
          message: expect.stringContaining(part.sku),
        }),
      );
    });

    it('skips a part that already has an active LOW_STOCK notification (transition-only dedup)', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([part]);
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.checkLowStock();

      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('reconciles multiple low-stock parts independently in one run', async () => {
      const partTwo = {
        ...part,
        id: 'part-2',
        sku: 'SEAL-40',
        quantityOnHand: 0,
        reorderThreshold: 3,
      };
      inventoryService.findAllLowStock.mockResolvedValue([part, partTwo]);
      notificationsService.hasActiveNotification.mockImplementation(
        async (_type: string, _entity: string, id: string) => id === 'part-2', // part -> not yet notified; partTwo -> already notified
      );
      txManager.createQueryBuilder.mockImplementation(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => txState.part),
      }));

      await service.checkLowStock();

      expect(notificationsService.record).toHaveBeenCalledTimes(1);
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({ relatedEntityId: part.id }),
      );
    });

    it('attaches the AI note to the LOW_STOCK notification', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([part]);
      notificationsService.hasActiveNotification.mockResolvedValue(false);
      aiInsightsService.generate.mockResolvedValue(
        'Possibly heavy recent usage. Check open work orders consuming this part.',
      );

      await service.checkLowStock();

      expect(aiInsightsService.generate).toHaveBeenCalledWith({
        kind: 'LOW_STOCK',
        partName: part.name,
        sku: part.sku,
        quantityOnHand: part.quantityOnHand,
        reorderThreshold: part.reorderThreshold,
      });
      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          aiNote:
            'Possibly heavy recent usage. Check open work orders consuming this part.',
        }),
      );
    });

    it('still creates the notification with aiNote null when the AI returns nothing', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([part]);
      notificationsService.hasActiveNotification.mockResolvedValue(false);
      aiInsightsService.generate.mockResolvedValue(null);

      await service.checkLowStock();

      expect(notificationsService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          type: NotificationType.LOW_STOCK,
          aiNote: null,
        }),
      );
    });

    it('does not call the AI for a part that already has an active notification', async () => {
      inventoryService.findAllLowStock.mockResolvedValue([part]);
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.checkLowStock();

      expect(aiInsightsService.generate).not.toHaveBeenCalled();
    });
  });
});

describe('ScheduledChecksService races and recurrence', () => {
  type FakeNotification = {
    type: string;
    entityId: string;
    status: 'UNREAD' | 'RESOLVED';
    resolvedByUserId: string | null;
  };

  const actor = { id: 'user-1', email: 'a@b.c', roles: [] } as any;
  const DAY = 24 * 60 * 60 * 1000;

  let state: { part: any; plan: any };
  let notifications: FakeNotification[];
  let lock: Promise<unknown>;
  let manager: any;
  let dataSource: any;
  let notificationsService: any;
  let inventory: InventoryService;
  let plans: MaintenancePlansService;
  let scheduler: ScheduledChecksService;
  let ai: { generate: jest.Mock };

  const active = (type: string) =>
    notifications.filter((n) => n.type === type && n.status === 'UNREAD');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    state = {
      part: {
        id: 'part-1',
        sku: 'BRG-6205',
        name: 'Bearing',
        quantityOnHand: 2,
        reorderThreshold: 5,
        unitCost: 1,
      },
      plan: {
        id: 'plan-1',
        assetId: 'asset-1',
        name: 'Lubrication',
        intervalDays: 30,
        active: true,
        nextDueAt: new Date(Date.now() - DAY),
      },
    };
    notifications = [];
    lock = Promise.resolve();

    manager = {
      createQueryBuilder: (entity: unknown) => ({
        setLock: () => ({
          where: () => ({
            getOne: async () =>
              entity === SparePart ? state.part : state.plan,
          }),
        }),
      }),
      findOne: async () => state.plan,
      exists: async () => false,
      create: (_e: unknown, plain: unknown) => plain,
      save: async (entity: unknown) => entity,
    };
    dataSource = {
      manager: { findOne: jest.fn(async () => null) },
      transaction: (cb: (m: any) => Promise<unknown>) => {
        const run = lock.then(() => cb(manager));
        lock = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    notificationsService = {
      hasActiveNotification: async (type: string, _e: string, id: string) =>
        active(type).some((n) => n.entityId === id),
      record: async (_m: unknown, p: any) => {
        notifications.push({
          type: p.type,
          entityId: p.relatedEntityId,
          status: 'UNREAD',
          resolvedByUserId: null,
        });
      },
      resolveActive: async (
        _m: unknown,
        type: string,
        _e: string,
        id: string,
      ) => {
        active(type)
          .filter((n) => n.entityId === id)
          .forEach((n) => (n.status = 'RESOLVED'));
      },
    };
    ai = { generate: jest.fn(async () => null) };

    inventory = new InventoryService(
      {} as any,
      {} as any,
      dataSource,
      { record: jest.fn(async () => ({})) } as any,
      notificationsService,
    );
    plans = new MaintenancePlansService(
      {} as any,
      {} as any,
      dataSource,
      { record: jest.fn(async () => ({})) } as any,
      notificationsService,
    );
    // snapshot-style listings, exactly like the hourly queries
    (inventory as any).findAllLowStock = async () =>
      state.part.quantityOnHand <= state.part.reorderThreshold
        ? [{ ...state.part }]
        : [];
    const plansForScheduler = {
      findAllDue: async () =>
        state.plan.active && state.plan.nextDueAt <= new Date()
          ? [{ ...state.plan }]
          : [],
    };
    scheduler = new ScheduledChecksService(
      plansForScheduler as any,
      inventory,
      notificationsService,
      dataSource,
      { exists: jest.fn(async () => false) } as any,
      ai as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('low stock', () => {
    it('creates one notification for an active low-stock condition and dedups on the next run', async () => {
      await scheduler.checkLowStock();
      await scheduler.checkLowStock();

      expect(active('LOW_STOCK')).toHaveLength(1);
    });

    it('does not insert a stale notification when a restock commits after the scheduler read its snapshot', async () => {
      ai.generate.mockImplementation(async () => {
        await inventory.restock('part-1', { quantity: 10 } as any, actor);
        return null;
      });

      await scheduler.checkLowStock();

      expect(state.part.quantityOnHand).toBe(12);
      expect(notifications).toHaveLength(0);
    });

    it('a restock that runs after the scheduler inserted resolves that notification', async () => {
      await scheduler.checkLowStock();
      await inventory.restock('part-1', { quantity: 10 } as any, actor);

      expect(active('LOW_STOCK')).toHaveLength(0);
      expect(notifications[0].status).toBe('RESOLVED');
      expect(notifications[0].resolvedByUserId).toBeNull();
    });

    it('concurrent scheduler runs do not create duplicate notifications', async () => {
      ai.generate.mockImplementation(
        () => new Promise((resolve) => setImmediate(() => resolve(null))),
      );

      await Promise.all([scheduler.checkLowStock(), scheduler.checkLowStock()]);

      expect(notifications).toHaveLength(1);
    });

    it('recurrence: low -> notify -> restock -> resolved -> low again -> new notification (history kept)', async () => {
      await scheduler.checkLowStock();
      expect(active('LOW_STOCK')).toHaveLength(1);

      await inventory.restock('part-1', { quantity: 10 } as any, actor);
      expect(active('LOW_STOCK')).toHaveLength(0);

      // still above threshold: the scheduler stays quiet
      await scheduler.checkLowStock();
      expect(notifications).toHaveLength(1);

      await inventory.adjust(
        'part-1',
        { delta: -10, reason: 'used' } as any,
        actor,
      );
      await scheduler.checkLowStock();

      expect(notifications.map((n) => n.status)).toEqual([
        'RESOLVED',
        'UNREAD',
      ]);

      await scheduler.checkLowStock(); // dedup while still active
      expect(notifications).toHaveLength(2);
    });
  });

  describe('overdue maintenance', () => {
    it('creates one notification for an active overdue plan and dedups on the next run', async () => {
      await scheduler.checkOverdueMaintenance();
      await scheduler.checkOverdueMaintenance();

      expect(active('OVERDUE_MAINTENANCE')).toHaveLength(1);
    });

    it('does not insert a stale notification when the plan is deactivated after the scheduler read its snapshot', async () => {
      ai.generate.mockImplementation(async () => {
        await plans.update('plan-1', { active: false } as any, actor);
        return null;
      });

      await scheduler.checkOverdueMaintenance();

      expect(notifications).toHaveLength(0);
    });

    it('does not insert a stale notification when the due date is moved to the future meanwhile', async () => {
      ai.generate.mockImplementation(async () => {
        await plans.update(
          'plan-1',
          { nextDueAt: new Date(Date.now() + 5 * DAY).toISOString() } as any,
          actor,
        );
        return null;
      });

      await scheduler.checkOverdueMaintenance();

      expect(notifications).toHaveLength(0);
    });

    it('a plan update after the insert resolves that notification', async () => {
      await scheduler.checkOverdueMaintenance();
      await plans.update('plan-1', { active: false } as any, actor);

      expect(active('OVERDUE_MAINTENANCE')).toHaveLength(0);
      expect(notifications[0].status).toBe('RESOLVED');
    });

    it('concurrent scheduler runs do not create duplicate notifications', async () => {
      ai.generate.mockImplementation(
        () => new Promise((resolve) => setImmediate(() => resolve(null))),
      );

      await Promise.all([
        scheduler.checkOverdueMaintenance(),
        scheduler.checkOverdueMaintenance(),
      ]);

      expect(notifications).toHaveLength(1);
    });
  });
});
