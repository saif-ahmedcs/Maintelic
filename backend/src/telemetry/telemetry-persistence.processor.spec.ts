import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { RequestContext } from '../common/context/request-context';
import { TelemetryPersistenceProcessor } from './telemetry-persistence.processor';
import { TelemetryPersistenceJobData } from './interfaces/telemetry-persistence-job-data.interface';
import {
  TELEMETRY_PERSISTENCE_BACKOFF_TYPE,
  TELEMETRY_PERSISTENCE_MAX_ATTEMPTS,
} from './telemetry-queue.config';

describe('TelemetryPersistenceProcessor', () => {
  let processor: TelemetryPersistenceProcessor;
  let service: { persistDeferred: jest.Mock };

  const data: TelemetryPersistenceJobData = {
    readingId: '6f1c1c0e-5b8e-4a77-9f0e-0d6f6d3f2a11',
    reading: {
      assetId: 'd57d9ca9-0d4a-4151-ad92-88c8ab13b930',
      temperature: 45,
      vibration: 2.2,
      pressure: 6,
      recordedAt: '2026-09-24T10:00:00.000Z',
    },
    correlationId: 'corr-1',
  };

  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      id: data.readingId,
      data,
      attemptsMade: 0,
      opts: { attempts: TELEMETRY_PERSISTENCE_MAX_ATTEMPTS },
      ...overrides,
    }) as any;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = { persistDeferred: jest.fn(async () => 'persisted') };
    processor = new TelemetryPersistenceProcessor(service as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists the queued reading under the original correlation id', async () => {
    let seenRequestId: string | undefined;
    service.persistDeferred.mockImplementation(async () => {
      seenRequestId = RequestContext.requestId;
      return 'persisted';
    });

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(service.persistDeferred).toHaveBeenCalledWith(data);
    expect(seenRequestId).toBe('corr-1');
  });

  it('rethrows a transient failure so BullMQ retries the job with backoff', async () => {
    const error = new Error('postgres still down');
    service.persistDeferred.mockRejectedValue(error);

    await expect(processor.process(job())).rejects.toBe(error);
  });

  it('completes the job quietly when the asset is unknown', async () => {
    service.persistDeferred.mockResolvedValue('unknown-asset');

    await expect(processor.process(job())).resolves.toBeUndefined();
  });

  it('fails a permanently rejected reading without retries (UnrecoverableError)', async () => {
    service.persistDeferred.mockResolvedValue('permanent');

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('logs recovery once a reading that failed earlier is finally stored', async () => {
    await processor.process(job({ attemptsMade: 4 }));

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('after 4 failed attempt'),
    );
  });

  describe('failed event', () => {
    it('warns (and does not alarm) while retries remain', () => {
      processor.onFailed(job({ attemptsMade: 3 }), new Error('down'));

      expect(Logger.prototype.warn).toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('logs an error with the full payload when the retries are exhausted', () => {
      processor.onFailed(
        job({ attemptsMade: TELEMETRY_PERSISTENCE_MAX_ATTEMPTS }),
        new Error('down'),
      );

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(data.reading)),
        expect.any(String),
      );
    });

    it('logs an error immediately for an unrecoverable failure', () => {
      processor.onFailed(
        job({ attemptsMade: 1 }),
        new UnrecoverableError('rejected'),
      );

      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('ignores an event without a job', () => {
      expect(() => processor.onFailed(undefined, new Error('x'))).not.toThrow();
    });
  });

  describe('backoff strategy registered on the worker', () => {
    const strategy = (): ((a: number, t?: string) => number) => {
      const options = Reflect.getMetadata(
        'bullmq:worker_metadata',
        processor.constructor,
      );
      return options.settings.backoffStrategy;
    };

    it('is the capped strategy, keyed by the job backoff type', () => {
      const backoff = strategy();
      expect(backoff(1, TELEMETRY_PERSISTENCE_BACKOFF_TYPE)).toBeGreaterThan(0);
      expect(
        backoff(500, TELEMETRY_PERSISTENCE_BACKOFF_TYPE),
      ).toBeLessThanOrEqual(36_000);
    });

    it('rejects a backoff type it does not own', () => {
      expect(() => strategy()(1, 'exponential')).toThrow(/Unknown backoff/);
    });
  });
});
