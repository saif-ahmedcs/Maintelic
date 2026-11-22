import { In } from 'typeorm';
import {
  Notification,
  NotificationStatus,
  NotificationType,
} from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

describe('NotificationsService lifecycle', () => {
  let service: NotificationsService;
  let repo: { count: jest.Mock };
  let manager: { update: jest.Mock; getRepository: jest.Mock };
  let txRepo: { count: jest.Mock };

  beforeEach(() => {
    repo = { count: jest.fn(async () => 0) };
    txRepo = { count: jest.fn(async () => 0) };
    manager = {
      update: jest.fn(async () => ({ affected: 1 })),
      getRepository: jest.fn(() => txRepo),
    };
    service = new NotificationsService(repo as any);
  });

  describe('hasActiveNotification (deduplication)', () => {
    it('only counts UNREAD and ACKNOWLEDGED, so RESOLVED never suppresses a new occurrence', async () => {
      await service.hasActiveNotification(
        NotificationType.LOW_STOCK,
        'SparePart',
        'part-1',
      );

      expect(repo.count).toHaveBeenCalledWith({
        where: {
          type: NotificationType.LOW_STOCK,
          relatedEntityType: 'SparePart',
          relatedEntityId: 'part-1',
          status: In([
            NotificationStatus.UNREAD,
            NotificationStatus.ACKNOWLEDGED,
          ]),
        },
      });
    });

    it('is true while an active notification exists and false after it is resolved', async () => {
      repo.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      const args = [NotificationType.CRITICAL_ASSET, 'Asset', 'a-1'] as const;
      await expect(service.hasActiveNotification(...args)).resolves.toBe(true);
      await expect(service.hasActiveNotification(...args)).resolves.toBe(false);
    });

    it('runs on the transaction manager when one is given', async () => {
      txRepo.count.mockResolvedValue(1);

      const result = await service.hasActiveNotification(
        NotificationType.CRITICAL_ASSET,
        'Asset',
        'a-1',
        manager as any,
      );

      expect(result).toBe(true);
      expect(manager.getRepository).toHaveBeenCalledWith(Notification);
      expect(repo.count).not.toHaveBeenCalled();
    });
  });

  describe('resolveActive', () => {
    it('resolves only active notifications of that type and entity, as the system, preserving the rows', async () => {
      const count = await service.resolveActive(
        manager as any,
        NotificationType.LOW_STOCK,
        'SparePart',
        'part-1',
      );

      expect(count).toBe(1);
      const [entity, criteria, patch] = manager.update.mock.calls[0];
      expect(entity).toBe(Notification);
      expect(criteria).toEqual({
        type: NotificationType.LOW_STOCK,
        relatedEntityType: 'SparePart',
        relatedEntityId: 'part-1',
        status: In([
          NotificationStatus.UNREAD,
          NotificationStatus.ACKNOWLEDGED,
        ]),
      });
      expect(patch).toEqual({
        status: NotificationStatus.RESOLVED,
        resolvedAt: expect.any(Date),
        resolvedByUserId: null,
      });
    });

    it('reports 0 when nothing was active', async () => {
      manager.update.mockResolvedValue({});

      await expect(
        service.resolveActive(
          manager as any,
          NotificationType.LOW_STOCK,
          'SparePart',
          'part-1',
        ),
      ).resolves.toBe(0);
    });
  });
});
