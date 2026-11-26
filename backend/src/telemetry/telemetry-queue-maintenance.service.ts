import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import {
  COMPLETED_JOB_RETENTION,
  FAILED_JOB_RETENTION,
} from '../common/queue/job-retention';
import { TELEMETRY_QUEUE_NAME } from './telemetry-queue.config';
import { TelemetryJobData } from './interfaces/telemetry-job-data.interface';

type FinishedState = 'completed' | 'failed';

@Injectable()
export class TelemetryQueueMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelemetryQueueMaintenanceService.name);
  private inFlight: Promise<void> | null = null;

  constructor(
    @InjectQueue(TELEMETRY_QUEUE_NAME)
    private readonly telemetryQueue: Queue<TelemetryJobData>,
  ) {}

  onApplicationBootstrap(): void {
    void this.runCleanup();
  }

  async onModuleDestroy(): Promise<void> {
    await this.inFlight;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledCleanup(): Promise<void> {
    await this.runCleanup();
  }

  runCleanup(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.cleanup()
        .catch((err: unknown) => {
          this.logger.error(
            'Telemetry queue cleanup failed',
            err instanceof Error ? err.stack : String(err),
          );
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async cleanup(): Promise<void> {
    const completed = await this.trim('completed', COMPLETED_JOB_RETENTION);
    const failed = await this.trim('failed', FAILED_JOB_RETENTION);

    if (completed > 0 || failed > 0) {
      this.logger.log(
        `Telemetry queue cleanup removed ${completed} completed and ${failed} failed jobs`,
      );
    }
  }

  private async trim(
    state: FinishedState,
    policy: { age: number; count: number },
  ): Promise<number> {
    const byAge = await this.telemetryQueue.clean(policy.age * 1000, 0, state);

    const counts = await this.telemetryQueue.getJobCounts(state);
    const excess = (counts[state] ?? 0) - policy.count;
    const byCount =
      excess > 0 ? await this.telemetryQueue.clean(0, excess, state) : [];

    return byAge.length + byCount.length;
  }
}
