export interface JobRetention {
  age: number;
  count: number;
}

export const COMPLETED_JOB_RETENTION: JobRetention = {
  age: 60 * 60, // seconds (1 hour)
  count: 100,
};

export const FAILED_JOB_RETENTION: JobRetention = {
  age: 7 * 24 * 60 * 60, // seconds (7 days)
  count: 1000,
};

export const DEFAULT_JOB_RETENTION_OPTIONS = {
  removeOnComplete: { ...COMPLETED_JOB_RETENTION },
  removeOnFail: { ...FAILED_JOB_RETENTION },
};
