import {
  classifyPersistError,
  getSqlState,
  TelemetryNotPersistedError,
} from './telemetry-persist-error';

const pg = (code: string) => Object.assign(new Error(code), { code });
const wrapped = (code: string) =>
  Object.assign(new Error('QueryFailedError'), { driverError: { code } });

describe('classifyPersistError', () => {
  it('treats a foreign-key violation as an unknown asset', () => {
    expect(classifyPersistError(pg('23503'))).toBe('unknown-asset');
    expect(classifyPersistError(wrapped('23503'))).toBe('unknown-asset');
  });

  it('treats a unique violation as an already persisted reading', () => {
    expect(classifyPersistError(pg('23505'))).toBe('already-persisted');
    expect(classifyPersistError(wrapped('23505'))).toBe('already-persisted');
  });

  it.each(['22001', '22003', '22007', '22P02', '23502', '23514', '23P01'])(
    'treats data / integrity SQLSTATE %s as permanent',
    (code) => {
      expect(classifyPersistError(pg(code))).toBe('permanent');
      expect(classifyPersistError(wrapped(code))).toBe('permanent');
    },
  );

  it.each([
    '08000', // connection exception
    '08006', // connection failure
    '25006', // read only sql transaction (failover to a replica)
    '40001', // serialization failure
    '40P01', // deadlock detected
    '53200', // out of memory
    '53300', // too many connections
    '55P03', // lock not available
    '57014', // query canceled (statement timeout)
    '57P01', // admin shutdown
    '57P02', // crash shutdown
    '57P03', // cannot connect now (startup / recovery)
    '58000', // system error
    '42P01', // undefined table (e.g. mid-migration)
    'XX000', // internal error
  ])('treats SQLSTATE %s as transient', (code) => {
    expect(classifyPersistError(pg(code))).toBe('transient');
    expect(classifyPersistError(wrapped(code))).toBe('transient');
  });

  it.each([
    ['ECONNRESET', pg('ECONNRESET')],
    ['EPIPE', pg('EPIPE')],
    ['ETIMEDOUT', pg('ETIMEDOUT')],
    ['ECONNREFUSED', pg('ECONNREFUSED')],
    ['plain Error', new Error('Connection terminated unexpectedly')],
    ['pool timeout', new Error('timeout exceeded when trying to connect')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('treats an error without a SQLSTATE (%s) as transient', (_l, err) => {
    expect(classifyPersistError(err)).toBe('transient');
  });

  it('does not mistake a 5-character Node error code for a data error', () => {
    // "EPIPE" has the shape of a SQLSTATE but class "EP" is not 22 or 23.
    expect(getSqlState(pg('EPIPE'))).toBe('EPIPE');
    expect(classifyPersistError(pg('EPIPE'))).toBe('transient');
  });

  it('prefers the driver error code over a non-SQLSTATE top-level code', () => {
    const err = Object.assign(new Error('x'), {
      code: 'ERR_X',
      driverError: { code: '23503' },
    });
    expect(classifyPersistError(err)).toBe('unknown-asset');
  });
});

describe('TelemetryNotPersistedError', () => {
  it('carries the asset, the reading id and the cause', () => {
    const cause = new Error('redis down');
    const err = new TelemetryNotPersistedError('asset-1', 'reading-1', cause);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TelemetryNotPersistedError');
    expect(err.assetId).toBe('asset-1');
    expect(err.readingId).toBe('reading-1');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('reading-1');
  });
});
