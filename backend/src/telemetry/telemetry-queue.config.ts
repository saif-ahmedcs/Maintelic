import type { DefaultJobOptions } from 'bullmq';
import { DEFAULT_JOB_RETENTION_OPTIONS } from '../common/queue/job-retention';

export const TELEMETRY_QUEUE_NAME = 'telemetry-processing';

export const TELEMETRY_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  ...DEFAULT_JOB_RETENTION_OPTIONS,
};

export const telemetryQueueRegistration = {
  name: TELEMETRY_QUEUE_NAME,
  defaultJobOptions: TELEMETRY_JOB_OPTIONS,
};
