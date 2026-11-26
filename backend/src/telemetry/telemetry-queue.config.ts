import type { DefaultJobOptions } from 'bullmq';
import {
  COMPLETED_JOB_RETENTION,
  DEFAULT_JOB_RETENTION_OPTIONS,
} from '../common/queue/job-retention';

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

export const TELEMETRY_PERSISTENCE_QUEUE_NAME = 'telemetry-persistence';
export const TELEMETRY_PERSISTENCE_BACKOFF_TYPE = 'telemetry-capped-backoff';
export const TELEMETRY_PERSISTENCE_BACKOFF_BASE_MS = 1_000;
export const TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS = 30_000;
export const TELEMETRY_PERSISTENCE_MAX_ATTEMPTS = 1_000;

export const TELEMETRY_PERSISTENCE_FAILED_RETENTION = {
  age: 7 * 24 * 60 * 60, // seconds (7 days)
  count: 100_000,
};

export const TELEMETRY_PERSISTENCE_JOB_OPTIONS: DefaultJobOptions = {
  attempts: TELEMETRY_PERSISTENCE_MAX_ATTEMPTS,
  backoff: { type: TELEMETRY_PERSISTENCE_BACKOFF_TYPE },
  removeOnComplete: { ...COMPLETED_JOB_RETENTION },
  removeOnFail: { ...TELEMETRY_PERSISTENCE_FAILED_RETENTION },
};

export const telemetryPersistenceQueueRegistration = {
  name: TELEMETRY_PERSISTENCE_QUEUE_NAME,
  defaultJobOptions: TELEMETRY_PERSISTENCE_JOB_OPTIONS,
};

export const TELEMETRY_PERSISTENCE_CONCURRENCY = 10;

export const TELEMETRY_HANDOFF_ATTEMPTS = 3;
export const TELEMETRY_HANDOFF_ATTEMPT_TIMEOUT_MS = 5_000;
export const TELEMETRY_HANDOFF_RETRY_DELAY_MS = 250;

export function telemetryPersistenceBackoff(
  attemptsMade: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptsMade - 1);
  const uncapped = TELEMETRY_PERSISTENCE_BACKOFF_BASE_MS * 2 ** exponent;
  const capped = Math.min(uncapped, TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS);
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.round(capped * jitter);
}
