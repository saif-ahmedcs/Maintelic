import { Test, TestingModule } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  COMPLETED_JOB_RETENTION,
  DEFAULT_JOB_RETENTION_OPTIONS,
  FAILED_JOB_RETENTION,
} from './../src/common/queue/job-retention';
import {
  TELEMETRY_JOB_OPTIONS,
  telemetryQueueRegistration,
} from './../src/telemetry/telemetry-queue.config';
import { TelemetryQueueMaintenanceService } from './../src/telemetry/telemetry-queue-maintenance.service';
import { poll } from './utils/poll';

describe('Telemetry queue retention (e2e)', () => {
  const connection = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  };
  const queueName = `telemetry-retention-e2e-${randomUUID()}`;

  let moduleRef: TestingModule;
  let queue: Queue;
  let redis: Redis;
  let worker: Worker | undefined;

  const keysFor = async (): Promise<string[]> => {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `bull:${queueName}:*`,
        'COUNT',
        1000,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  };

  const jobHashKeys = async () =>
    (await keysFor()).filter((k) => /:\d+$/.test(k));

  const waitForDrain = async (total: number, state: 'completed' | 'failed') =>
    poll(
      async () => {
        const c = await queue.getJobCounts('wait', 'active', 'delayed');
        const done = await queue.getJobCounts(state);
        const processed = (worker as any)?.__processed as number;
        return c.wait + c.active + c.delayed === 0 && processed >= total
          ? done
          : null;
      },
      { timeoutMs: 30_000, intervalMs: 100 },
    );

  const startWorker = (fail: boolean) => {
    const w = new Worker(
      queueName,
      async () => {
        (w as any).__processed = ((w as any).__processed ?? 0) + 1;
        if (fail) {
          throw new Error('boom');
        }
      },
      { connection, concurrency: 20 },
    );
    (w as any).__processed = 0;
    worker = w;
    return w;
  };

  const stopWorker = async () => {
    await worker?.close();
    worker = undefined;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection,
          defaultJobOptions: DEFAULT_JOB_RETENTION_OPTIONS,
        }),
        BullModule.registerQueue({
          ...telemetryQueueRegistration,
          name: queueName,
        }),
      ],
    }).compile();
    await moduleRef.init();

    queue = moduleRef.get<Queue>(getQueueToken(queueName));
    redis = new Redis(connection);
  });

  afterEach(async () => {
    await stopWorker();
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await redis.quit();
    await moduleRef.close();
  });

  it('removes completed jobs (and their Redis hashes) beyond the retention count', async () => {
    startWorker(false);
    const total = COMPLETED_JOB_RETENTION.count * 3;

    // Producer passes explicit options, exactly like TelemetryService.ingest.
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        queue.add('reading', { n: i }, TELEMETRY_JOB_OPTIONS),
      ),
    );
    const counts = await waitForDrain(total, 'completed');

    expect(counts.completed).toBeLessThanOrEqual(COMPLETED_JOB_RETENTION.count);
    expect(await jobHashKeys()).toHaveLength(counts.completed);
    expect(await jobHashKeys()).not.toHaveLength(total);
  });

  it('applies the retention policy through the queue defaults alone', async () => {
    startWorker(false);
    const total = COMPLETED_JOB_RETENTION.count * 2;

    // No per-job options: relies purely on defaultJobOptions.
    await Promise.all(
      Array.from({ length: total }, (_, i) => queue.add('reading', { n: i })),
    );
    const counts = await waitForDrain(total, 'completed');

    expect(counts.completed).toBeLessThanOrEqual(COMPLETED_JOB_RETENTION.count);
    expect(await jobHashKeys()).toHaveLength(counts.completed);
  });

  it('caps permanently failed jobs at the failed-retention count', async () => {
    startWorker(true);
    const total = FAILED_JOB_RETENTION.count + 200;

    // attempts: 1 so every job fails permanently on its first run.
    await Promise.all(
      Array.from({ length: total }, (_, i) =>
        queue.add(
          'reading',
          { n: i },
          { ...TELEMETRY_JOB_OPTIONS, attempts: 1 },
        ),
      ),
    );
    const counts = await waitForDrain(total, 'failed');

    expect(counts.failed).toBeLessThanOrEqual(FAILED_JOB_RETENTION.count);
    expect(await jobHashKeys()).toHaveLength(counts.failed);
  });

  it('cleans up a legacy backlog enqueued without any retention policy', async () => {
    const legacy = COMPLETED_JOB_RETENTION.count * 4;
    startWorker(false);
    // Simulates the pre-fix behaviour: nothing is ever removed.
    await Promise.all(
      Array.from({ length: legacy }, (_, i) =>
        queue.add(
          'reading',
          { n: i },
          { removeOnComplete: false, removeOnFail: false },
        ),
      ),
    );
    const backlog = await waitForDrain(legacy, 'completed');
    expect(backlog.completed).toBe(legacy);
    expect(await jobHashKeys()).toHaveLength(legacy);
    await stopWorker();

    const maintenance = new TelemetryQueueMaintenanceService(queue as any);
    await maintenance.runCleanup();

    const after = await queue.getJobCounts('completed', 'failed');
    expect(after.completed).toBeLessThanOrEqual(COMPLETED_JOB_RETENTION.count);
    expect(await jobHashKeys()).toHaveLength(after.completed + after.failed);
  });
});
