import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { paginate, PaginatedResult } from '../common/pagination/paginate';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TelemetryReadingDto } from './dto/telemetry-reading.dto';
import { TelemetryReadingResponseDto } from './dto/telemetry-reading-response.dto';
import { TelemetrySummaryResponseDto } from './dto/telemetry-summary-response.dto';
import { TelemetryReading } from './entities/telemetry-reading.entity';
import { TelemetryJobData } from './interfaces/telemetry-job-data.interface';
import { TelemetryPersistenceJobData } from './interfaces/telemetry-persistence-job-data.interface';
import {
  classifyPersistError,
  TelemetryNotPersistedError,
} from './telemetry-persist-error';
import {
  TELEMETRY_HANDOFF_ATTEMPT_TIMEOUT_MS,
  TELEMETRY_HANDOFF_ATTEMPTS,
  TELEMETRY_HANDOFF_RETRY_DELAY_MS,
  TELEMETRY_JOB_OPTIONS,
  TELEMETRY_PERSISTENCE_JOB_OPTIONS,
  TELEMETRY_PERSISTENCE_QUEUE_NAME,
  TELEMETRY_QUEUE_NAME,
} from './telemetry-queue.config';

const TELEMETRY_SORTABLE_FIELDS = ['reading.recordedAt'];

const latestCacheKey = (assetId: string) => `telemetry:latest:${assetId}`;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const errorStack = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? err.message) : String(err);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type InsertResult =
  | { status: 'persisted' }
  | { status: 'dropped'; reason: 'unknown-asset' | 'permanent' }
  | { status: 'transient'; error: unknown };

export type DeferredPersistOutcome =
  'persisted' | 'unknown-asset' | 'permanent';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(TelemetryReading)
    private readonly readings: Repository<TelemetryReading>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(TELEMETRY_QUEUE_NAME)
    private readonly telemetryQueue: Queue<TelemetryJobData>,
    @InjectQueue(TELEMETRY_PERSISTENCE_QUEUE_NAME)
    private readonly persistenceQueue: Queue<TelemetryPersistenceJobData>,
  ) {}

  async ingest(
    reading: TelemetryReadingDto,
    correlationId?: string,
  ): Promise<void> {
    const job: TelemetryPersistenceJobData = {
      readingId: randomUUID(),
      reading,
      correlationId: correlationId ?? randomUUID(),
    };

    const result = await this.insertOnce(job.readingId, reading);
    switch (result.status) {
      case 'persisted':
        await this.publishPersisted(job, 'live');
        return;
      case 'dropped':
        return;
      case 'transient':
        await this.handOffToDurableQueue(job, result.error);
        return;
    }
  }

  async persistDeferred(
    job: TelemetryPersistenceJobData,
  ): Promise<DeferredPersistOutcome> {
    const result = await this.insertOnce(job.readingId, job.reading);
    switch (result.status) {
      case 'persisted':
        await this.publishPersisted(job, 'deferred');
        return 'persisted';
      case 'dropped':
        return result.reason;
      case 'transient':
        throw result.error;
    }
  }

  async getLatest(assetId: string): Promise<TelemetryReadingResponseDto> {
    const cached = await this.readLatestFromCache(assetId);
    if (cached) {
      return cached;
    }

    const latest = await this.readings.findOne({
      where: { assetId },
      order: { recordedAt: 'DESC' },
    });
    if (!latest) {
      throw new NotFoundException(
        `No telemetry readings found for asset ${assetId}`,
      );
    }
    return TelemetryReadingResponseDto.fromEntity(latest);
  }

  async findHistory(
    assetId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResult<TelemetryReadingResponseDto>> {
    const qb = this.readings
      .createQueryBuilder('reading')
      .where('reading.assetId = :assetId', { assetId });

    const result = await paginate(qb, query, {
      defaultSortBy: 'reading.recordedAt',
      allowedSortFields: TELEMETRY_SORTABLE_FIELDS,
    });

    return {
      data: result.data.map((r) => TelemetryReadingResponseDto.fromEntity(r)),
      meta: result.meta,
    };
  }

  async getLatestBatch(
    assetIds: string[],
  ): Promise<Record<string, TelemetryReadingResponseDto>> {
    if (assetIds.length === 0) {
      return {};
    }

    const latestPerAsset = await this.readings
      .createQueryBuilder('reading')
      .distinctOn(['reading.assetId'])
      .where('reading.assetId IN (:...assetIds)', { assetIds })
      .orderBy('reading.assetId', 'ASC')
      .addOrderBy('reading.recordedAt', 'DESC')
      .getMany();

    const result: Record<string, TelemetryReadingResponseDto> = {};
    for (const reading of latestPerAsset) {
      result[reading.assetId] = TelemetryReadingResponseDto.fromEntity(reading);
    }
    return result;
  }

  async getSummary(since: string): Promise<TelemetrySummaryResponseDto> {
    const summary = await this.readings
      .createQueryBuilder('reading')
      .select('COUNT(reading.id)', 'readingCount')
      .addSelect('COUNT(DISTINCT reading.assetId)', 'assetCount')
      .where('reading.recordedAt >= :since', { since })
      .getRawOne<{ readingCount: string; assetCount: string }>();

    return {
      readingCount: Number(summary?.readingCount ?? 0),
      assetCount: Number(summary?.assetCount ?? 0),
      since,
    };
  }

  private async readLatestFromCache(
    assetId: string,
  ): Promise<TelemetryReadingResponseDto | null> {
    try {
      const raw = await this.redis.get(latestCacheKey(assetId));
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as TelemetryReadingResponseDto;
      return {
        assetId: parsed.assetId,
        temperature: parsed.temperature,
        vibration: parsed.vibration,
        pressure: parsed.pressure,
        recordedAt: parsed.recordedAt,
      };
    } catch (err) {
      this.logger.warn(
        `Latest-reading cache unavailable for asset ${assetId}, falling back to Postgres: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async insertOnce(
    readingId: string,
    reading: TelemetryReadingDto,
  ): Promise<InsertResult> {
    try {
      await this.readings.insert({
        id: readingId,
        assetId: reading.assetId,
        temperature: reading.temperature,
        vibration: reading.vibration,
        pressure: reading.pressure,
        recordedAt: new Date(reading.recordedAt),
      });
      return { status: 'persisted' };
    } catch (err) {
      switch (classifyPersistError(err)) {
        case 'already-persisted':
          return { status: 'persisted' };
        case 'unknown-asset':
          this.logger.warn(
            `Dropped telemetry reading for unknown asset ${reading.assetId}`,
          );
          return { status: 'dropped', reason: 'unknown-asset' };
        case 'permanent':
          this.logger.error(
            `Dropped telemetry reading ${readingId} for asset ${reading.assetId}: Postgres rejected it permanently (${errorMessage(err)}); payload=${JSON.stringify(reading)}`,
            errorStack(err),
          );
          return { status: 'dropped', reason: 'permanent' };
        case 'transient':
          return { status: 'transient', error: err };
      }
    }
  }

  private async handOffToDurableQueue(
    job: TelemetryPersistenceJobData,
    cause: unknown,
  ): Promise<void> {
    const { assetId } = job.reading;
    this.logger.warn(
      `Transient Postgres failure persisting telemetry reading ${job.readingId} for asset ${assetId} (${errorMessage(cause)}); handing it to the durable persistence queue`,
    );

    let handOffError: unknown = cause;
    for (let attempt = 1; attempt <= TELEMETRY_HANDOFF_ATTEMPTS; attempt++) {
      try {
        await withTimeout(
          this.persistenceQueue.add('persist', job, {
            ...TELEMETRY_PERSISTENCE_JOB_OPTIONS,
            jobId: job.readingId,
          }),
          TELEMETRY_HANDOFF_ATTEMPT_TIMEOUT_MS,
          'Enqueueing telemetry persistence job',
        );
        return;
      } catch (err) {
        handOffError = err;
        this.logger.warn(
          `Could not enqueue telemetry reading ${job.readingId} for durable persistence (attempt ${attempt}/${TELEMETRY_HANDOFF_ATTEMPTS}): ${errorMessage(err)}`,
        );
        if (attempt < TELEMETRY_HANDOFF_ATTEMPTS) {
          await delay(TELEMETRY_HANDOFF_RETRY_DELAY_MS * attempt);
        }
      }
    }

    this.logger.error(
      `TELEMETRY READING LOST: ${job.readingId} could be neither persisted nor queued; payload=${JSON.stringify(job.reading)}`,
      errorStack(handOffError),
    );
    throw new TelemetryNotPersistedError(assetId, job.readingId, handOffError);
  }

  private async publishPersisted(
    job: TelemetryPersistenceJobData,
    mode: 'live' | 'deferred',
  ): Promise<void> {
    const { reading, correlationId } = job;
    try {
      if (mode === 'deferred') {
        await this.setLatestUnlessNewer(reading);
      } else {
        await this.redis.set(
          latestCacheKey(reading.assetId),
          JSON.stringify(reading),
        );
      }
      const jobData: TelemetryJobData = { reading, correlationId };
      await this.telemetryQueue.add('reading', jobData, TELEMETRY_JOB_OPTIONS);
    } catch (err) {
      if (mode === 'deferred') {
        throw err;
      }
      this.logger.error(
        `Failed to cache/enqueue telemetry reading for asset ${reading.assetId}`,
        errorStack(err),
      );
    }
  }

  private async setLatestUnlessNewer(
    reading: TelemetryReadingDto,
  ): Promise<void> {
    const key = latestCacheKey(reading.assetId);
    const raw = await this.redis.get(key);
    if (raw) {
      try {
        const cached = JSON.parse(raw) as { recordedAt?: string };
        if (
          cached.recordedAt !== undefined &&
          Date.parse(cached.recordedAt) > Date.parse(reading.recordedAt)
        ) {
          return;
        }
      } catch {
        // Unreadable cache entry: overwrite it.
      }
    }
    await this.redis.set(key, JSON.stringify(reading));
  }
}
