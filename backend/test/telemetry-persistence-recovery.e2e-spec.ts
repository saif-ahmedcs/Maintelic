import { Test, TestingModule } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DEFAULT_JOB_RETENTION_OPTIONS } from './../src/common/queue/job-retention';
import { REDIS_CLIENT } from './../src/redis/redis.module';
import { TelemetryReading } from './../src/telemetry/entities/telemetry-reading.entity';
import { TelemetryPersistenceProcessor } from './../src/telemetry/telemetry-persistence.processor';
import {
  TELEMETRY_PERSISTENCE_QUEUE_NAME,
  TELEMETRY_QUEUE_NAME,
  telemetryPersistenceQueueRegistration,
  telemetryQueueRegistration,
} from './../src/telemetry/telemetry-queue.config';
import { TelemetryService } from './../src/telemetry/telemetry.service';
import { poll } from './utils/poll';

describe('Telemetry persistence recovery (e2e)', () => {
  const connection = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  };

  class FakeReadingsRepo {
    rows = new Map<string, Record<string, any>>();
    insertCalls = 0;
    failures: Array<() => Error | { storeThenFail: Error }> = [];

    async insert(row: Record<string, any>): Promise<void> {
      this.insertCalls++;
      const failure = this.failures.shift()?.();
      if (failure && !('storeThenFail' in failure)) {
        throw failure;
      }
      if (this.rows.has(row.id)) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      this.rows.set(row.id, row);
      if (failure && 'storeThenFail' in failure) {
        throw failure.storeThenFail;
      }
    }
  }

  const connectionReset = () =>
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const adminShutdown = () =>
    Object.assign(new Error('terminating connection'), { code: '57P01' });

  let moduleRef: TestingModule | undefined;
  let repo: FakeReadingsRepo;
  let redis: Redis;
  let service: TelemetryService;
  let persistenceQueue: Queue;
  let processingQueue: Queue;
  const assetIds: string[] = [];
  const correlationIds: string[] = [];

  const newReading = () => {
    const assetId = randomUUID();
    assetIds.push(assetId);
    return {
      assetId,
      temperature: 61.4,
      vibration: 2.1,
      pressure: 5.9,
      recordedAt: new Date().toISOString(),
    };
  };

  const boot = async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection,
          defaultJobOptions: DEFAULT_JOB_RETENTION_OPTIONS,
        }),
        BullModule.registerQueue(
          telemetryQueueRegistration,
          telemetryPersistenceQueueRegistration,
        ),
      ],
      providers: [
        TelemetryService,
        TelemetryPersistenceProcessor,
        { provide: getRepositoryToken(TelemetryReading), useValue: repo },
        { provide: REDIS_CLIENT, useFactory: () => new Redis(connection) },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(TelemetryService);
    redis = moduleRef.get(REDIS_CLIENT);
    persistenceQueue = moduleRef.get(
      getQueueToken(TELEMETRY_PERSISTENCE_QUEUE_NAME),
    );
    processingQueue = moduleRef.get(getQueueToken(TELEMETRY_QUEUE_NAME));
  };

  const shutdown = async () => {
    await moduleRef?.close();
    await redis?.quit();
    moduleRef = undefined;
  };

  const processingJobsFor = async (correlationId: string) =>
    (
      await processingQueue.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
      ])
    ).filter((j) => j?.data?.correlationId === correlationId);

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    repo = new FakeReadingsRepo();
    await boot();
  });

  afterEach(async () => {
    // Only touch what this test created: the queues carry other tests' jobs.
    for (const q of [persistenceQueue, processingQueue]) {
      const jobs = await q.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
        'failed',
      ]);
      for (const job of jobs) {
        if (correlationIds.includes(job?.data?.correlationId)) {
          await job.remove().catch(() => undefined);
        }
      }
    }
    for (const assetId of assetIds) {
      await redis.del(`telemetry:latest:${assetId}`);
    }
    await shutdown();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const ingest = async (reading: ReturnType<typeof newReading>) => {
    const correlationId = randomUUID();
    correlationIds.push(correlationId);
    await service.ingest(reading, correlationId);
    return correlationId;
  };

  it('stores a reading immediately when Postgres is healthy, without touching the persistence queue', async () => {
    const reading = newReading();

    const correlationId = await ingest(reading);

    expect(repo.rows.size).toBe(1);
    expect(await persistenceQueue.getJobCounts('waiting', 'delayed')).toEqual({
      waiting: 0,
      delayed: 0,
    });
    expect(
      JSON.parse((await redis.get(`telemetry:latest:${reading.assetId}`))!),
    ).toEqual(reading);
    expect(await processingJobsFor(correlationId)).toHaveLength(1);
  });

  it('keeps a reading through a Postgres outage and stores it once, after Postgres recovers', async () => {
    const reading = newReading();
    // outage: the first insert and the next two retries all fail
    repo.failures = [adminShutdown, connectionReset, adminShutdown];

    const correlationId = await ingest(reading);

    // The handler returned without losing anything: nothing is stored yet, the
    // reading is held in Redis and has NOT been published as "latest".
    expect(repo.rows.size).toBe(0);
    expect(await redis.get(`telemetry:latest:${reading.assetId}`)).toBeNull();

    // Postgres comes back; the worker's retries (1s, 2s, ... backoff) land.
    const stored = await poll(
      async () => (repo.rows.size === 1 ? repo : null),
      {
        timeoutMs: 25_000,
        intervalMs: 200,
      },
    );

    expect(stored.insertCalls).toBe(4); // 3 failures + 1 success
    const [row] = [...repo.rows.values()];
    expect(row).toMatchObject({
      assetId: reading.assetId,
      temperature: reading.temperature,
      vibration: reading.vibration,
      pressure: reading.pressure,
      recordedAt: new Date(reading.recordedAt),
    });

    // Post-persist publishing happened, under the original correlation id.
    await poll(async () =>
      (await processingJobsFor(correlationId)).length === 1 ? true : null,
    );
    expect(
      JSON.parse((await redis.get(`telemetry:latest:${reading.assetId}`))!),
    ).toEqual(reading);

    // ...and the persistence job completed (it is not retried forever).
    await poll(async () =>
      (await persistenceQueue.getJobCounts('completed')).completed > 0
        ? true
        : null,
    );
  }, 40_000);

  it('does not lose a reading when this process restarts during the outage', async () => {
    const reading = newReading();
    repo.failures = [adminShutdown, adminShutdown];
    const correlationId = await ingest(reading);
    expect(repo.rows.size).toBe(0);

    // The process goes away with the reading only in Redis...
    await shutdown();

    // ...and a fresh process (Postgres healthy again) picks it up.
    repo.failures = [];
    await boot();

    await poll(async () => (repo.rows.size === 1 ? true : null), {
      timeoutMs: 25_000,
      intervalMs: 200,
    });
    await poll(async () =>
      (await processingJobsFor(correlationId)).length === 1 ? true : null,
    );
  }, 40_000);

  it('stores the reading exactly once when a failure is ambiguous (committed, then the connection died)', async () => {
    const reading = newReading();
    repo.failures = [() => ({ storeThenFail: connectionReset() }) as any];

    await ingest(reading);

    await poll(async () => (repo.insertCalls >= 2 ? true : null), {
      timeoutMs: 15_000,
    });
    await poll(async () =>
      (await persistenceQueue.getJobCounts('completed')).completed > 0
        ? true
        : null,
    );

    expect(repo.rows.size).toBe(1);
  }, 30_000);

  it('drops a reading for an unknown asset instead of queueing it', async () => {
    const reading = newReading();
    repo.failures = [
      () => Object.assign(new Error('fk violation'), { code: '23503' }),
    ];

    const correlationId = await ingest(reading);

    expect(repo.insertCalls).toBe(1);
    expect(repo.rows.size).toBe(0);
    expect(await persistenceQueue.getJobCounts('waiting', 'delayed')).toEqual({
      waiting: 0,
      delayed: 0,
    });
    expect(await processingJobsFor(correlationId)).toHaveLength(0);
    expect(await redis.get(`telemetry:latest:${reading.assetId}`)).toBeNull();
  });

  it('does not clobber a newer cached reading when an older one is replayed late', async () => {
    const older = newReading();
    const newer = {
      ...older,
      temperature: 99,
      recordedAt: new Date(Date.parse(older.recordedAt) + 1000).toISOString(),
    };
    repo.failures = [adminShutdown];
    await ingest(older); // queued; DB failed

    // a live reading for the same asset arrives and is stored/cached first
    await ingest(newer);
    expect(
      JSON.parse((await redis.get(`telemetry:latest:${older.assetId}`))!)
        .temperature,
    ).toBe(99);

    // the older reading is replayed by the worker once its backoff elapses
    await poll(async () => (repo.rows.size === 2 ? true : null), {
      timeoutMs: 15_000,
    });
    await poll(async () =>
      (await persistenceQueue.getJobCounts('completed')).completed > 0
        ? true
        : null,
    );

    expect(
      JSON.parse((await redis.get(`telemetry:latest:${older.assetId}`))!)
        .temperature,
    ).toBe(99);
  }, 30_000);
});
