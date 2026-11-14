import { Logger, NotFoundException } from '@nestjs/common';
import { TelemetryReadingDto } from './dto/telemetry-reading.dto';
import { TelemetryService } from './telemetry.service';

describe('TelemetryService', () => {
  let service: TelemetryService;
  let readingRepo: {
    insert: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let redis: { set: jest.Mock; get: jest.Mock };
  let queue: { add: jest.Mock };

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

    service = new TelemetryService(
      readingRepo as any,
      redis as any,
      queue as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists, caches and enqueues a valid reading', async () => {
    await service.ingest(reading);

    expect(readingRepo.insert).toHaveBeenCalledWith({
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
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );
  });

  it('carries an explicitly provided correlationId onto the queued job', async () => {
    await service.ingest(reading, 'corr-abc-123');

    expect(queue.add).toHaveBeenCalledWith(
      'reading',
      { reading, correlationId: 'corr-abc-123' },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
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

    expect(redis.set).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not cache or enqueue when the insert fails for another reason, and does not throw', async () => {
    readingRepo.insert.mockRejectedValue(new Error('connection lost'));

    await expect(service.ingest(reading)).resolves.toBeUndefined();

    expect(redis.set).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
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
      expect(qb.where).toHaveBeenCalledWith('reading.assetId IN (:...assetIds)', {
        assetIds: [reading.assetId, assetTwoId],
      });
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
