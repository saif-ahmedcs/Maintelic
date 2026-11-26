import { Logger, NotFoundException } from '@nestjs/common';
import { TelemetryReadingDto } from './dto/telemetry-reading.dto';
import { TelemetryService } from './telemetry.service';
import { TelemetryNotPersistedError } from './telemetry-persist-error';
import {
  TELEMETRY_HANDOFF_ATTEMPT_TIMEOUT_MS,
  TELEMETRY_HANDOFF_ATTEMPTS,
  TELEMETRY_JOB_OPTIONS,
  TELEMETRY_PERSISTENCE_JOB_OPTIONS,
} from './telemetry-queue.config';

const pgError = (code: string, message = `pg error ${code}`) =>
  Object.assign(new Error(message), { code });

describe('TelemetryService', () => {
  let service: TelemetryService;
  let readingRepo: {
    insert: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let redis: { set: jest.Mock; get: jest.Mock };
  let queue: { add: jest.Mock };
  let persistenceQueue: { add: jest.Mock };

  const reading: TelemetryReadingDto = {
    assetId: 'd57d9ca9-0d4a-4151-ad92-88c8ab13b930',
    temperature: 45,
    vibration: 2.2,
    pressure: 6,
    recordedAt: '2026-09-24T10:00:00.000Z',
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    readingRepo = {
      insert: jest.fn(async () => ({})),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    redis = { set: jest.fn(async () => 'OK'), get: jest.fn() };
    queue = { add: jest.fn(async () => ({})) };
    persistenceQueue = { add: jest.fn(async () => ({})) };

    service = new TelemetryService(
      readingRepo as any,
      redis as any,
      queue as any,
      persistenceQueue as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists, caches and enqueues a valid reading', async () => {
    await service.ingest(reading);

    expect(readingRepo.insert).toHaveBeenCalledWith({
      id: expect.any(String),
      assetId: reading.assetId,
      temperature: reading.temperature,
      vibration: reading.vibration,
      pressure: reading.pressure,
      recordedAt: new Date(reading.recordedAt),
    });
    expect(redis.set).toHaveBeenCalledWith(
      `telemetry:latest:${reading.assetId}`,
      JSON.stringify(reading),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'reading',
      { reading, correlationId: expect.any(String) },
      TELEMETRY_JOB_OPTIONS,
    );
    expect(persistenceQueue.add).not.toHaveBeenCalled();
  });

  it('enqueues jobs with bounded retention for finished jobs (BJM-1)', async () => {
    await service.ingest(reading);

    const options = queue.add.mock.calls[0][2];
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 1000 });
    expect(options.removeOnComplete).toEqual({
      age: expect.any(Number),
      count: expect.any(Number),
    });
    expect(options.removeOnFail).toEqual({
      age: expect.any(Number),
      count: expect.any(Number),
    });
    expect(options.removeOnComplete.count).toBeGreaterThan(0);
    expect(options.removeOnComplete.age).toBeGreaterThan(0);
    expect(options.removeOnFail.count).toBeGreaterThan(0);
    expect(options.removeOnFail.age).toBeGreaterThan(0);
  });

  it('carries an explicitly provided correlationId onto the queued job', async () => {
    await service.ingest(reading, 'corr-abc-123');

    expect(queue.add).toHaveBeenCalledWith(
      'reading',
      { reading, correlationId: 'corr-abc-123' },
      TELEMETRY_JOB_OPTIONS,
    );
  });

  it('writes to Postgres before Redis and the queue', async () => {
    const order: string[] = [];
    readingRepo.insert.mockImplementation(async () => {
      order.push('db');
    });
    redis.set.mockImplementation(async () => {
      order.push('redis');
    });
    queue.add.mockImplementation(async () => {
      order.push('queue');
    });

    await service.ingest(reading);

    expect(order).toEqual(['db', 'redis', 'queue']);
  });

  it('drops a reading for an unknown asset without caching or enqueueing it', async () => {
    readingRepo.insert.mockRejectedValue(
      Object.assign(new Error('fk violation'), { code: '23503' }),
    );

    await expect(service.ingest(reading)).resolves.toBeUndefined();

    expect(readingRepo.insert).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(persistenceQueue.add).not.toHaveBeenCalled();
  });

  it('recognises a foreign-key violation wrapped by TypeORM (driverError.code)', async () => {
    readingRepo.insert.mockRejectedValue(
      Object.assign(new Error('QueryFailedError'), {
        driverError: { code: '23503' },
      }),
    );

    await expect(service.ingest(reading)).resolves.toBeUndefined();

    expect(persistenceQueue.add).not.toHaveBeenCalled();
  });

  describe('permanent insert errors (BJM-2)', () => {
    it.each([
      ['22003', 'numeric value out of range'],
      ['22P02', 'invalid text representation'],
      ['23502', 'not-null violation'],
      ['23514', 'check violation'],
    ])(
      'drops the reading on SQLSTATE %s (%s) without retrying or queueing it',
      async (code) => {
        readingRepo.insert.mockRejectedValue(pgError(code));

        await expect(service.ingest(reading)).resolves.toBeUndefined();

        expect(readingRepo.insert).toHaveBeenCalledTimes(1);
        expect(persistenceQueue.add).not.toHaveBeenCalled();
        expect(redis.set).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalled();
      },
    );
  });

  describe('transient insert errors (BJM-2)', () => {
    it.each([
      [
        'connection reset (no SQLSTATE)',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      ],
      ['plain error without a code', new Error('connection lost')],
      ['pool timeout', new Error('timeout exceeded when trying to connect')],
      ['admin shutdown 57P01', pgError('57P01')],
      ['cannot connect now 57P03', pgError('57P03')],
      ['connection failure 08006', pgError('08006')],
      ['too many connections 53300', pgError('53300')],
      ['read-only transaction after failover 25006', pgError('25006')],
      ['serialization failure 40001', pgError('40001')],
      ['deadlock 40P01', pgError('40P01')],
      [
        'TypeORM-wrapped 57P01',
        Object.assign(new Error('QueryFailedError'), {
          driverError: { code: '57P01' },
        }),
      ],
    ])(
      'hands the reading to the durable queue instead of dropping it: %s',
      async (_label, error) => {
        readingRepo.insert.mockRejectedValue(error);

        await expect(
          service.ingest(reading, 'corr-1'),
        ).resolves.toBeUndefined();

        expect(persistenceQueue.add).toHaveBeenCalledTimes(1);
        const [name, data, options] = persistenceQueue.add.mock.calls[0];
        expect(name).toBe('persist');
        expect(data).toEqual({
          readingId: expect.any(String),
          reading,
          correlationId: 'corr-1',
        });
        expect(options).toEqual({
          ...TELEMETRY_PERSISTENCE_JOB_OPTIONS,
          jobId: data.readingId,
        });
        // Not published as "latest" / for monitoring until it is really stored.
        expect(redis.set).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('queues the same id that the failed insert used, so the replay is idempotent', async () => {
      readingRepo.insert.mockRejectedValue(new Error('connection lost'));

      await service.ingest(reading);

      const insertedId = readingRepo.insert.mock.calls[0][0].id;
      expect(persistenceQueue.add.mock.calls[0][1].readingId).toBe(insertedId);
      expect(persistenceQueue.add.mock.calls[0][2].jobId).toBe(insertedId);
    });

    it('generates a correlation id for the queued job when none is supplied', async () => {
      readingRepo.insert.mockRejectedValue(new Error('connection lost'));

      await service.ingest(reading);

      expect(persistenceQueue.add.mock.calls[0][1].correlationId).toEqual(
        expect.any(String),
      );
    });

    it('treats a primary-key hit as already persisted (a retry of an ambiguous failure)', async () => {
      readingRepo.insert.mockRejectedValue(pgError('23505'));

      await service.ingest(reading);

      expect(persistenceQueue.add).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    describe('when the hand-off to Redis also fails', () => {
      beforeEach(() => {
        jest.useFakeTimers();
        readingRepo.insert.mockRejectedValue(new Error('postgres down'));
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('retries the hand-off and succeeds if Redis comes back', async () => {
        persistenceQueue.add
          .mockRejectedValueOnce(new Error('redis down'))
          .mockResolvedValueOnce({});

        const done = service.ingest(reading);
        await jest.advanceTimersByTimeAsync(10_000);

        await expect(done).resolves.toBeUndefined();
        expect(persistenceQueue.add).toHaveBeenCalledTimes(2);
        // same job id on every attempt: it can never be enqueued twice
        expect(persistenceQueue.add.mock.calls[0][2].jobId).toBe(
          persistenceQueue.add.mock.calls[1][2].jobId,
        );
      });

      it('rejects with TelemetryNotPersistedError and logs the full payload once every hand-off attempt failed', async () => {
        persistenceQueue.add.mockRejectedValue(new Error('redis down'));

        const done = service.ingest(reading);
        const assertion = expect(done).rejects.toBeInstanceOf(
          TelemetryNotPersistedError,
        );
        await jest.advanceTimersByTimeAsync(10_000);
        await assertion;

        expect(persistenceQueue.add).toHaveBeenCalledTimes(
          TELEMETRY_HANDOFF_ATTEMPTS,
        );
        const lostLog = (Logger.prototype.error as jest.Mock).mock.calls.find(
          ([msg]) => String(msg).includes('TELEMETRY READING LOST'),
        );
        expect(lostLog).toBeDefined();
        expect(lostLog![0]).toContain(JSON.stringify(reading));
      });

      it('does not wait forever on a Redis call that never settles', async () => {
        persistenceQueue.add.mockImplementation(() => new Promise(() => {}));

        const done = service.ingest(reading);
        const assertion = expect(done).rejects.toBeInstanceOf(
          TelemetryNotPersistedError,
        );
        await jest.advanceTimersByTimeAsync(
          TELEMETRY_HANDOFF_ATTEMPTS *
            (TELEMETRY_HANDOFF_ATTEMPT_TIMEOUT_MS + 2_000),
        );
        await assertion;

        expect(persistenceQueue.add).toHaveBeenCalledTimes(
          TELEMETRY_HANDOFF_ATTEMPTS,
        );
      });
    });
  });

  describe('persistDeferred (replay from the durable queue)', () => {
    const job = {
      readingId: '6f1c1c0e-5b8e-4a77-9f0e-0d6f6d3f2a11',
      reading,
      correlationId: 'corr-deferred',
    };

    it('inserts with the original id, then caches and enqueues for monitoring', async () => {
      await expect(service.persistDeferred(job)).resolves.toBe('persisted');

      expect(readingRepo.insert).toHaveBeenCalledWith({
        id: job.readingId,
        assetId: reading.assetId,
        temperature: reading.temperature,
        vibration: reading.vibration,
        pressure: reading.pressure,
        recordedAt: new Date(reading.recordedAt),
      });
      expect(redis.set).toHaveBeenCalledWith(
        `telemetry:latest:${reading.assetId}`,
        JSON.stringify(reading),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'reading',
        { reading, correlationId: 'corr-deferred' },
        TELEMETRY_JOB_OPTIONS,
      );
    });

    it('throws on a transient failure so BullMQ retries the job', async () => {
      const error = new Error('still down');
      readingRepo.insert.mockRejectedValue(error);

      await expect(service.persistDeferred(job)).rejects.toBe(error);

      expect(redis.set).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('treats a primary-key hit as success and still publishes (idempotent retry)', async () => {
      readingRepo.insert.mockRejectedValue(pgError('23505'));

      await expect(service.persistDeferred(job)).resolves.toBe('persisted');

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('reports an unknown asset without throwing or publishing', async () => {
      readingRepo.insert.mockRejectedValue(pgError('23503'));

      await expect(service.persistDeferred(job)).resolves.toBe('unknown-asset');

      expect(redis.set).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('reports a permanently rejected row without throwing or publishing', async () => {
      readingRepo.insert.mockRejectedValue(pgError('22003'));

      await expect(service.persistDeferred(job)).resolves.toBe('permanent');

      expect(redis.set).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer cached reading with a replayed older one', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ ...reading, recordedAt: '2026-09-24T10:05:00.000Z' }),
      );

      await service.persistDeferred(job);

      expect(redis.set).not.toHaveBeenCalled();
      // monitoring is still triggered: the row is now in Postgres
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('overwrites the cache when the replayed reading is the newest', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ ...reading, recordedAt: '2026-09-24T09:00:00.000Z' }),
      );

      await service.persistDeferred(job);

      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('overwrites an unreadable cache entry', async () => {
      redis.get.mockResolvedValue('{not json');

      await service.persistDeferred(job);

      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('propagates a Redis failure after the insert so the job is retried (the retry is idempotent)', async () => {
      redis.get.mockResolvedValue(null);
      redis.set.mockRejectedValue(new Error('redis down'));

      await expect(service.persistDeferred(job)).rejects.toThrow('redis down');

      expect(readingRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('propagates a monitoring-enqueue failure so the job is retried', async () => {
      queue.add.mockRejectedValue(new Error('queue down'));

      await expect(service.persistDeferred(job)).rejects.toThrow('queue down');
    });
  });

  describe('live reading vs. the cached latest (BJM-3: backlog replayed after an outage)', () => {
    it('does not overwrite a newer cached reading with an older live one', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ ...reading, recordedAt: '2026-09-24T10:05:00.000Z' }),
      );

      await service.ingest(reading);

      expect(readingRepo.insert).toHaveBeenCalledTimes(1);
      expect(redis.set).not.toHaveBeenCalled();
      // the row is stored, so condition monitoring is still triggered
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('overwrites the cache when the live reading is newer than the cached one', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ ...reading, recordedAt: '2026-09-24T09:00:00.000Z' }),
      );

      await service.ingest(reading);

      expect(redis.set).toHaveBeenCalledWith(
        `telemetry:latest:${reading.assetId}`,
        JSON.stringify(reading),
      );
    });

    it('overwrites the cache when the live reading carries the same timestamp', async () => {
      redis.get.mockResolvedValue(JSON.stringify(reading));

      await service.ingest(reading);

      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('overwrites an unreadable cache entry', async () => {
      redis.get.mockResolvedValue('{not json');

      await service.ingest(reading);

      expect(redis.set).toHaveBeenCalledTimes(1);
    });

    it('does not throw when reading the cache fails, and the reading stays persisted', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));

      await expect(service.ingest(reading)).resolves.toBeUndefined();

      expect(readingRepo.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent cache writes for one asset (BJM-3)', () => {
    // A Redis whose reads and writes take a moment, so that overlapping
    // handlers really do interleave, as they do when the backlog is replayed.
    const useSlowRedis = () => {
      const store = new Map<string, string>();
      const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
      redis.get.mockImplementation(async (key: string) => {
        const value = store.get(key) ?? null;
        await tick();
        return value;
      });
      redis.set.mockImplementation(async (key: string, value: string) => {
        await tick();
        store.set(key, value);
        return 'OK';
      });
      return store;
    };
    const at = (
      offsetMs: number,
      temperature: number,
    ): TelemetryReadingDto => ({
      ...reading,
      temperature,
      recordedAt: new Date(
        Date.parse(reading.recordedAt) + offsetMs,
      ).toISOString(),
    });
    const key = `telemetry:latest:${reading.assetId}`;

    it('keeps the newest reading when an older one is handled concurrently and finishes last', async () => {
      const store = useSlowRedis();

      await Promise.all([
        service.ingest(at(1000, 99)),
        service.ingest(at(0, 10)),
      ]);

      expect(JSON.parse(store.get(key) as string).temperature).toBe(99);
    });

    it('keeps the newest reading whichever order a replayed backlog is handled in', async () => {
      const store = useSlowRedis();
      const backlog = [3, 1, 4, 0, 2, 5].map((n) => at(n * 1000, n));

      await Promise.all(backlog.map((r) => service.ingest(r)));

      expect(JSON.parse(store.get(key) as string).temperature).toBe(5);
    });

    it('does not let one failed cache write block or poison the next one', async () => {
      const store = useSlowRedis();
      redis.set.mockRejectedValueOnce(new Error('redis down'));

      await service.ingest(at(0, 10));
      await service.ingest(at(1000, 99));

      expect(JSON.parse(store.get(key) as string).temperature).toBe(99);
    });

    it('does not keep per-asset bookkeeping once the writes are done', async () => {
      useSlowRedis();

      await service.ingest(at(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        (service as unknown as { latestCacheWrites: Map<string, unknown> })
          .latestCacheWrites.size,
      ).toBe(0);
    });
  });

  it('does not throw when Redis fails, and the reading stays persisted', async () => {
    redis.set.mockRejectedValue(new Error('redis down'));

    await expect(service.ingest(reading)).resolves.toBeUndefined();

    expect(readingRepo.insert).toHaveBeenCalledTimes(1);
  });

  describe('getLatest', () => {
    const dbRow = {
      id: 'row-1',
      assetId: reading.assetId,
      temperature: 44.9,
      vibration: 2.1,
      pressure: 5.9,
      recordedAt: new Date('2026-09-24T09:59:59.000Z'),
      ingestedAt: new Date('2026-09-24T10:00:00.000Z'),
    };
    const dbRowResponse = {
      assetId: reading.assetId,
      temperature: 44.9,
      vibration: 2.1,
      pressure: 5.9,
      recordedAt: '2026-09-24T09:59:59.000Z',
    };

    it('returns the cached reading without touching Postgres', async () => {
      redis.get.mockResolvedValue(JSON.stringify(reading));

      const result = await service.getLatest(reading.assetId);

      expect(redis.get).toHaveBeenCalledWith(
        `telemetry:latest:${reading.assetId}`,
      );
      expect(result).toEqual(reading);
      expect(readingRepo.findOne).not.toHaveBeenCalled();
    });

    it('falls back to the newest Postgres row on a cold cache', async () => {
      redis.get.mockResolvedValue(null);
      readingRepo.findOne.mockResolvedValue(dbRow);

      const result = await service.getLatest(reading.assetId);

      expect(readingRepo.findOne).toHaveBeenCalledWith({
        where: { assetId: reading.assetId },
        order: { recordedAt: 'DESC' },
      });
      expect(result).toEqual(dbRowResponse);
    });

    it('falls back to Postgres when Redis throws', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));
      readingRepo.findOne.mockResolvedValue(dbRow);

      await expect(service.getLatest(reading.assetId)).resolves.toEqual(
        dbRowResponse,
      );
    });

    it('falls back to Postgres when the cached value is not valid JSON', async () => {
      redis.get.mockResolvedValue('{not json');
      readingRepo.findOne.mockResolvedValue(dbRow);

      await expect(service.getLatest(reading.assetId)).resolves.toEqual(
        dbRowResponse,
      );
    });

    it('throws NotFoundException when there is no cache and no stored reading', async () => {
      redis.get.mockResolvedValue(null);
      readingRepo.findOne.mockResolvedValue(null);

      await expect(service.getLatest(reading.assetId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getLatestBatch', () => {
    let qb: {
      distinctOn: jest.Mock;
      where: jest.Mock;
      orderBy: jest.Mock;
      addOrderBy: jest.Mock;
      getMany: jest.Mock;
    };

    const assetTwoId = '2d1e9b3a-7c3b-4e3a-9e3a-1a2b3c4d5e6f';
    const unknownAssetId = '00000000-0000-4000-8000-000000000000';

    const row = (overrides: Partial<typeof dbRow>) => ({
      ...dbRow,
      ...overrides,
    });

    const dbRow = {
      id: 'row-1',
      assetId: reading.assetId,
      temperature: 44.9,
      vibration: 2.1,
      pressure: 5.9,
      recordedAt: new Date('2026-09-24T09:59:59.000Z'),
      ingestedAt: new Date('2026-09-24T10:00:00.000Z'),
    };

    beforeEach(() => {
      qb = {
        distinctOn: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(),
      };
      readingRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('returns {} without querying when no asset IDs are given', async () => {
      const result = await service.getLatestBatch([]);

      expect(result).toEqual({});
      expect(readingRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('issues exactly one query for the batch, selecting distinct on assetId', async () => {
      qb.getMany.mockResolvedValue([row({})]);

      await service.getLatestBatch([reading.assetId, assetTwoId]);

      expect(readingRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.getMany).toHaveBeenCalledTimes(1);
      expect(qb.distinctOn).toHaveBeenCalledWith(['reading.assetId']);
      expect(qb.where).toHaveBeenCalledWith(
        'reading.assetId IN (:...assetIds)',
        {
          assetIds: [reading.assetId, assetTwoId],
        },
      );
      expect(qb.orderBy).toHaveBeenCalledWith('reading.assetId', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('reading.recordedAt', 'DESC');
    });

    it('maps each returned row onto its asset ID, in the response DTO shape', async () => {
      qb.getMany.mockResolvedValue([
        row({ assetId: reading.assetId }),
        row({ assetId: assetTwoId, temperature: 50.1 }),
      ]);

      const result = await service.getLatestBatch([
        reading.assetId,
        assetTwoId,
      ]);

      expect(result).toEqual({
        [reading.assetId]: {
          assetId: reading.assetId,
          temperature: 44.9,
          vibration: 2.1,
          pressure: 5.9,
          recordedAt: '2026-09-24T09:59:59.000Z',
        },
        [assetTwoId]: {
          assetId: assetTwoId,
          temperature: 50.1,
          vibration: 2.1,
          pressure: 5.9,
          recordedAt: '2026-09-24T09:59:59.000Z',
        },
      });
    });

    it('omits requested asset IDs with no matching row (unknown or reading-less)', async () => {
      qb.getMany.mockResolvedValue([row({ assetId: reading.assetId })]);

      const result = await service.getLatestBatch([
        reading.assetId,
        unknownAssetId,
      ]);

      expect(Object.keys(result)).toEqual([reading.assetId]);
    });
  });

  describe('getSummary', () => {
    let qb: {
      select: jest.Mock;
      addSelect: jest.Mock;
      where: jest.Mock;
      getRawOne: jest.Mock;
    };

    beforeEach(() => {
      qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(),
      };
      readingRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('counts readings and distinct assets using the same since boundary', async () => {
      qb.getRawOne.mockResolvedValue({ readingCount: '42', assetCount: '7' });

      const result = await service.getSummary('2026-01-01T00:00:00.000Z');

      expect(readingRepo.createQueryBuilder).toHaveBeenCalledWith('reading');
      expect(qb.select).toHaveBeenCalledWith(
        'COUNT(reading.id)',
        'readingCount',
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        'COUNT(DISTINCT reading.assetId)',
        'assetCount',
      );
      expect(qb.where).toHaveBeenCalledWith('reading.recordedAt >= :since', {
        since: '2026-01-01T00:00:00.000Z',
      });
      expect(result).toEqual({
        readingCount: 42,
        assetCount: 7,
        since: '2026-01-01T00:00:00.000Z',
      });
    });

    it('returns zero counts (as numbers) when nothing matches since', async () => {
      qb.getRawOne.mockResolvedValue({ readingCount: '0', assetCount: '0' });

      const result = await service.getSummary('2099-01-01T00:00:00.000Z');

      expect(result).toEqual({
        readingCount: 0,
        assetCount: 0,
        since: '2099-01-01T00:00:00.000Z',
      });
    });
  });
});
