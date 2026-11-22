import { Asset, AssetStatus } from '../assets/entities/asset.entity';
import { ConditionMonitoringService } from './condition-monitoring.service';

describe('ConditionMonitoringService', () => {
  let service: ConditionMonitoringService;
  let readingRepo: { find: jest.Mock };
  let workOrderRepo: { exists: jest.Mock };
  let dataSource: { manager: { findOne: jest.Mock }; transaction: jest.Mock };
  let auditService: { record: jest.Mock };
  let assetHistoryService: { record: jest.Mock };
  let notificationsService: {
    record: jest.Mock;
    hasActiveNotification: jest.Mock;
    resolveActive: jest.Mock;
  };
  let aiInsightsService: { generate: jest.Mock };

  beforeEach(() => {
    readingRepo = { find: jest.fn(async () => []) };
    workOrderRepo = { exists: jest.fn(async () => false) };
    dataSource = {
      manager: { findOne: jest.fn() },
      transaction: jest.fn(),
    };
    auditService = { record: jest.fn() };
    assetHistoryService = { record: jest.fn() };
    notificationsService = {
      record: jest.fn(),
      hasActiveNotification: jest.fn(async () => false),
      resolveActive: jest.fn(async () => 1),
    };
    aiInsightsService = { generate: jest.fn() };

    service = new ConditionMonitoringService(
      readingRepo as any,
      workOrderRepo as any,
      dataSource as any,
      auditService as any,
      assetHistoryService as any,
      notificationsService as any,
      aiInsightsService as any,
    );
  });

  it('selects the "most recent" readings by server-assigned ingestedAt, not the publisher-controlled recordedAt', async () => {
    await service.evaluateAsset('asset-1');

    expect(readingRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { assetId: 'asset-1' },
        order: { ingestedAt: 'DESC' },
        take: 3,
      }),
    );
    const callArgs = readingRepo.find.mock.calls[0][0];
    expect(callArgs.order).not.toHaveProperty('recordedAt');
  });

  it('does nothing further once the rule does not trip', async () => {
    readingRepo.find.mockResolvedValue([
      { temperature: 50 },
      { temperature: 50 },
      { temperature: 50 },
    ]);

    await service.evaluateAsset('asset-1');

    expect(workOrderRepo.exists).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not open a second work order/notification when an active auto work order already exists', async () => {
    readingRepo.find.mockResolvedValue([
      { temperature: 90 },
      { temperature: 90 },
      { temperature: 90 },
    ]);
    workOrderRepo.exists.mockResolvedValue(true);

    await service.evaluateAsset('asset-1');

    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not create a duplicate notification when one is already active, even if the auto work order was cancelled', async () => {
    readingRepo.find.mockResolvedValue([
      { temperature: 90 },
      { temperature: 90 },
      { temperature: 90 },
    ]);
    workOrderRepo.exists.mockResolvedValue(false);
    notificationsService.hasActiveNotification.mockResolvedValue(true);

    await service.evaluateAsset('asset-1');

    expect(notificationsService.hasActiveNotification).toHaveBeenCalledWith(
      'CRITICAL_ASSET',
      'Asset',
      'asset-1',
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  describe('DECOMMISSIONED assets', () => {
    const hot = [{ temperature: 90 }, { temperature: 90 }, { temperature: 90 }];

    it('skips evaluation entirely: no status change, work order, notification, history or AI call', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.DECOMMISSIONED,
      });
      readingRepo.find.mockResolvedValue(hot);

      await service.evaluateAsset('asset-1');

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(workOrderRepo.exists).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(assetHistoryService.record).not.toHaveBeenCalled();
      expect(aiInsightsService.generate).not.toHaveBeenCalled();
    });

    it('re-checks under a row lock and aborts if the asset was decommissioned after the initial check', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
        tag: 'A-1',
      });
      readingRepo.find.mockResolvedValue(hot);
      const txAsset = { id: 'asset-1', status: AssetStatus.DECOMMISSIONED };
      const txManager = {
        findOne: jest.fn(async () => txAsset),
        save: jest.fn(),
        create: jest.fn(),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await service.evaluateAsset('asset-1');

      expect(txManager.findOne).toHaveBeenCalledWith(
        Asset,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(txAsset.status).toBe(AssetStatus.DECOMMISSIONED);
      expect(txManager.save).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(assetHistoryService.record).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('still marks a non-decommissioned asset CRITICAL and opens a work order + notification', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
        tag: 'A-1',
      });
      readingRepo.find.mockResolvedValue(hot);
      const txAsset = {
        id: 'asset-1',
        tag: 'A-1',
        status: AssetStatus.OPERATIONAL,
      };
      const txManager = {
        findOne: jest.fn(async () => txAsset),
        create: jest.fn((_e: unknown, plain: object) => plain),
        save: jest.fn(async (e: object) => ({ id: 'x', ...e })),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));

      await service.evaluateAsset('asset-1');

      expect(txAsset.status).toBe(AssetStatus.CRITICAL);
      expect(assetHistoryService.record).toHaveBeenCalledWith(
        txManager,
        expect.objectContaining({
          previousStatus: AssetStatus.OPERATIONAL,
          newStatus: AssetStatus.CRITICAL,
        }),
      );
      expect(notificationsService.record).toHaveBeenCalledTimes(1);
    });
  });

  describe('notification lifecycle / recurrence', () => {
    const hot = [{ temperature: 90 }, { temperature: 90 }, { temperature: 90 }];
    let txAsset: { id: string; tag: string; status: AssetStatus };
    let txManager: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };

    beforeEach(() => {
      readingRepo.find.mockResolvedValue(hot);
      txAsset = { id: 'asset-1', tag: 'A-1', status: AssetStatus.OPERATIONAL };
      txManager = {
        findOne: jest.fn(async () => txAsset),
        create: jest.fn((_e: unknown, plain: object) => plain),
        save: jest.fn(async (e: object) => ({ id: 'x', ...e })),
      };
      dataSource.transaction.mockImplementation((cb: any) => cb(txManager));
    });

    it('creates a new alert + work order after the previous notification was resolved', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
        tag: 'A-1',
      });
      // previous notification already RESOLVED -> nothing active
      notificationsService.hasActiveNotification.mockResolvedValue(false);

      await service.evaluateAsset('asset-1');

      expect(txAsset.status).toBe(AssetStatus.CRITICAL);
      expect(notificationsService.record).toHaveBeenCalledTimes(1);
      expect(notificationsService.resolveActive).not.toHaveBeenCalled();
    });

    it('still suppresses duplicates while the asset really is CRITICAL with an active notification', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.CRITICAL,
      });
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.evaluateAsset('asset-1');

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });

    it('treats an active notification as stale when the asset is no longer critical: resolves it and raises a new alert', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
        tag: 'A-1',
      });
      notificationsService.hasActiveNotification.mockResolvedValue(true);

      await service.evaluateAsset('asset-1');

      expect(notificationsService.resolveActive).toHaveBeenCalledWith(
        txManager,
        'CRITICAL_ASSET',
        'Asset',
        'asset-1',
      );
      expect(txAsset.status).toBe(AssetStatus.CRITICAL);
      expect(notificationsService.record).toHaveBeenCalledTimes(1);
    });

    it('concurrency: a competing worker already raised the alert -> authoritative re-check under the lock creates nothing', async () => {
      dataSource.manager.findOne.mockResolvedValue({
        id: 'asset-1',
        status: AssetStatus.OPERATIONAL,
        tag: 'A-1',
      });
      // outside the tx nothing is active; inside, the other worker's commit is visible
      notificationsService.hasActiveNotification
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      txAsset.status = AssetStatus.CRITICAL;

      await service.evaluateAsset('asset-1');

      expect(
        notificationsService.hasActiveNotification,
      ).toHaveBeenLastCalledWith(
        'CRITICAL_ASSET',
        'Asset',
        'asset-1',
        txManager,
      );
      expect(txManager.save).not.toHaveBeenCalled();
      expect(notificationsService.record).not.toHaveBeenCalled();
    });
  });
});
