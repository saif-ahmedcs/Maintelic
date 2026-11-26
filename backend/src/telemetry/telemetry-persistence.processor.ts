import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { RequestContext } from '../common/context/request-context';
import { TelemetryPersistenceJobData } from './interfaces/telemetry-persistence-job-data.interface';
import {
  TELEMETRY_PERSISTENCE_BACKOFF_TYPE,
  TELEMETRY_PERSISTENCE_CONCURRENCY,
  TELEMETRY_PERSISTENCE_QUEUE_NAME,
  telemetryPersistenceBackoff,
} from './telemetry-queue.config';
import { TelemetryService } from './telemetry.service';

@Processor(TELEMETRY_PERSISTENCE_QUEUE_NAME, {
  concurrency: TELEMETRY_PERSISTENCE_CONCURRENCY,
  settings: {
    backoffStrategy: (attemptsMade: number, type?: string) => {
      if (type !== TELEMETRY_PERSISTENCE_BACKOFF_TYPE) {
        throw new Error(`Unknown backoff strategy "${type}"`);
      }
      return telemetryPersistenceBackoff(attemptsMade);
    },
  },
})
export class TelemetryPersistenceProcessor extends WorkerHost {
  private readonly logger = new Logger(TelemetryPersistenceProcessor.name);

  constructor(private readonly telemetryService: TelemetryService) {
    super();
  }

  async process(job: Job<TelemetryPersistenceJobData>): Promise<void> {
    const { readingId, reading, correlationId } = job.data;

    await RequestContext.run({ requestId: correlationId }, async () => {
      const outcome = await this.telemetryService.persistDeferred(job.data);

      switch (outcome) {
        case 'persisted':
          if (job.attemptsMade > 0) {
            this.logger.log(
              `Persisted queued telemetry reading ${readingId} for asset ${reading.assetId} after ${job.attemptsMade} failed attempt(s)`,
            );
          }
          return;
        case 'unknown-asset':
          return;
        case 'permanent':
          throw new UnrecoverableError(
            `Postgres permanently rejected telemetry reading ${readingId} for asset ${reading.assetId}`,
          );
      }
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TelemetryPersistenceJobData> | undefined, err: Error) {
    if (!job) {
      return;
    }
    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted =
      err instanceof UnrecoverableError || job.attemptsMade >= maxAttempts;

    if (exhausted) {
      this.logger.error(
        `Giving up on queued telemetry reading ${job.data.readingId} for asset ${job.data.reading.assetId} after ${job.attemptsMade} attempt(s): ${err.message}; payload=${JSON.stringify(job.data.reading)}`,
        err.stack,
      );
    } else {
      this.logger.warn(
        `Queued telemetry reading ${job.data.readingId} for asset ${job.data.reading.assetId} not persisted yet (attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`,
      );
    }
  }
}
