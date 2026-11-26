import { Logger } from '@nestjs/common';
import {
  COMPLETED_JOB_RETENTION,
  FAILED_JOB_RETENTION,
} from '../common/queue/job-retention';
import { TelemetryQueueMaintenanceService } from './telemetry-queue-maintenance.service';

describe('TelemetryQueueMaintenanceService', () => {
  let service: TelemetryQueueMaintenanceService;
  let queue: { clean: jest.Mock; getJobCounts: jest.Mock };
  let counts: { completed: number; failed: number };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    counts = { completed: 0, failed: 0 };
    queue = {
      clean: jest.fn(async () => [] as string[]),
      getJobCounts: jest.fn(async () => counts),
    };
    service = new TelemetryQueueMaintenanceService(queue as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cleans completed and failed jobs older than their retention age', async () => {
    await service.runCleanup();

    expect(queue.clean).toHaveBeenCalledWith(
      COMPLETED_JOB_RETENTION.age * 1000,
      0,
      'completed',
    );
    expect(queue.clean).toHaveBeenCalledWith(
      FAILED_JOB_RETENTION.age * 1000,
      0,
      'failed',
    );
  });

  it('trims the oldest jobs beyond the retention count', async () => {
    counts = {
      completed: COMPLETED_JOB_RETENTION.count + 250,
      failed: FAILED_JOB_RETENTION.count + 40,
    };

    await service.runCleanup();

    expect(queue.clean).toHaveBeenCalledWith(0, 250, 'completed');
    expect(queue.clean).toHaveBeenCalledWith(0, 40, 'failed');
  });

  it('does not run a count trim when the sets are within their caps', async () => {
    counts = {
      completed: COMPLETED_JOB_RETENTION.count,
      failed: FAILED_JOB_RETENTION.count,
    };

    await service.runCleanup();

    expect(queue.clean).toHaveBeenCalledTimes(2);
    expect(queue.clean).not.toHaveBeenCalledWith(
      0,
      expect.anything(),
      'completed',
    );
    expect(queue.clean).not.toHaveBeenCalledWith(
      0,
      expect.anything(),
      'failed',
    );
  });

  it('never rejects when Redis fails, and can run again afterwards', async () => {
    queue.clean.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.runCleanup()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalled();

    queue.clean.mockClear();
    await service.runCleanup();
    expect(queue.clean).toHaveBeenCalled();
  });

  it('shares one sweep between overlapping calls', async () => {
    let release!: () => void;
    queue.clean.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => (release = () => resolve([]))),
    );

    const first = service.runCleanup();
    const second = service.runCleanup();
    expect(second).toBe(first);

    release();
    await first;
    expect(queue.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it('runs a sweep on bootstrap and waits for it on module destroy', async () => {
    service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(queue.clean).toHaveBeenCalled();
  });
});
