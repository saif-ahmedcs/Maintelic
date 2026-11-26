import {
  TELEMETRY_PERSISTENCE_BACKOFF_BASE_MS,
  TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS,
  TELEMETRY_PERSISTENCE_BACKOFF_TYPE,
  TELEMETRY_PERSISTENCE_FAILED_RETENTION,
  TELEMETRY_PERSISTENCE_JOB_OPTIONS,
  TELEMETRY_PERSISTENCE_MAX_ATTEMPTS,
  telemetryPersistenceBackoff,
  telemetryPersistenceQueueRegistration,
} from './telemetry-queue.config';

describe('telemetry persistence queue config', () => {
  const noJitter = () => 0.5;

  it('doubles the delay on each failed attempt, starting at the base delay', () => {
    expect(telemetryPersistenceBackoff(1, noJitter)).toBe(
      TELEMETRY_PERSISTENCE_BACKOFF_BASE_MS,
    );
    expect(telemetryPersistenceBackoff(2, noJitter)).toBe(2_000);
    expect(telemetryPersistenceBackoff(3, noJitter)).toBe(4_000);
    expect(telemetryPersistenceBackoff(4, noJitter)).toBe(8_000);
  });

  it('is capped, however many attempts have failed', () => {
    expect(telemetryPersistenceBackoff(10, noJitter)).toBe(
      TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS,
    );
    expect(telemetryPersistenceBackoff(900, noJitter)).toBe(
      TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS,
    );
    expect(
      Number.isFinite(telemetryPersistenceBackoff(100_000, noJitter)),
    ).toBe(true);
  });

  it('stays within +/-20% jitter of the capped delay', () => {
    expect(telemetryPersistenceBackoff(20, () => 0)).toBe(24_000);
    expect(telemetryPersistenceBackoff(20, () => 1)).toBe(36_000);
    for (let i = 0; i < 200; i++) {
      const delay = telemetryPersistenceBackoff(20);
      expect(delay).toBeGreaterThanOrEqual(24_000);
      expect(delay).toBeLessThanOrEqual(36_000);
    }
  });

  it('never returns a non-positive delay', () => {
    expect(telemetryPersistenceBackoff(0, () => 0)).toBeGreaterThan(0);
    expect(telemetryPersistenceBackoff(-5, () => 0)).toBeGreaterThan(0);
  });

  it('retries for hours but is bounded, with a custom backoff', () => {
    expect(TELEMETRY_PERSISTENCE_JOB_OPTIONS.attempts).toBe(
      TELEMETRY_PERSISTENCE_MAX_ATTEMPTS,
    );
    expect(TELEMETRY_PERSISTENCE_JOB_OPTIONS.backoff).toEqual({
      type: TELEMETRY_PERSISTENCE_BACKOFF_TYPE,
    });
    const hoursOfRetries =
      (TELEMETRY_PERSISTENCE_MAX_ATTEMPTS *
        TELEMETRY_PERSISTENCE_BACKOFF_MAX_MS) /
      3_600_000;
    expect(hoursOfRetries).toBeGreaterThanOrEqual(6);
    expect(hoursOfRetries).toBeLessThanOrEqual(12);
  });

  it('keeps jobs that exhausted their retries for a week, in large numbers', () => {
    expect(TELEMETRY_PERSISTENCE_JOB_OPTIONS.removeOnFail).toEqual(
      TELEMETRY_PERSISTENCE_FAILED_RETENTION,
    );
    expect(TELEMETRY_PERSISTENCE_FAILED_RETENTION.age).toBe(7 * 24 * 3600);
    expect(TELEMETRY_PERSISTENCE_FAILED_RETENTION.count).toBeGreaterThan(1000);
  });

  it('trims completed jobs so Redis does not grow without bound (BJM-1)', () => {
    const { removeOnComplete } = TELEMETRY_PERSISTENCE_JOB_OPTIONS as {
      removeOnComplete: { age: number; count: number };
    };
    expect(removeOnComplete.age).toBeGreaterThan(0);
    expect(removeOnComplete.count).toBeGreaterThan(0);
  });

  it('registers the queue under its own name with the same defaults', () => {
    expect(telemetryPersistenceQueueRegistration).toEqual({
      name: 'telemetry-persistence',
      defaultJobOptions: TELEMETRY_PERSISTENCE_JOB_OPTIONS,
    });
  });
});
