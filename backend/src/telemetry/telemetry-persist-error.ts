const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
const POSTGRES_UNIQUE_VIOLATION = '23505';
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

export type PersistErrorKind =
  'unknown-asset' | 'already-persisted' | 'permanent' | 'transient';

interface PgLikeError {
  code?: unknown;
  driverError?: { code?: unknown } | null;
}

export function getSqlState(err: unknown): string | undefined {
  const e = err as PgLikeError | null | undefined;
  const candidates = [e?.driverError?.code, e?.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && SQLSTATE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function classifyPersistError(err: unknown): PersistErrorKind {
  const sqlState = getSqlState(err);
  if (!sqlState) {
    return 'transient';
  }
  if (sqlState === POSTGRES_FOREIGN_KEY_VIOLATION) {
    return 'unknown-asset';
  }
  if (sqlState === POSTGRES_UNIQUE_VIOLATION) {
    return 'already-persisted';
  }
  const sqlClass = sqlState.slice(0, 2);
  if (sqlClass === '22' || sqlClass === '23') {
    return 'permanent';
  }
  return 'transient';
}

export class TelemetryNotPersistedError extends Error {
  constructor(
    readonly assetId: string,
    readonly readingId: string,
    cause: unknown,
  ) {
    super(
      `Telemetry reading ${readingId} for asset ${assetId} could not be persisted or queued`,
      { cause },
    );
    this.name = 'TelemetryNotPersistedError';
  }
}
