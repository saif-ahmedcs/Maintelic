import { request } from '../api/client';
import { ApiError } from '../api/errors';

const FIELD_LIMITS = {
  message: 1000,
  stack: 8000,
  route: 500,
  requestId: 100,
  appVersion: 50,
} as const;

const DEDUPE_WINDOW_MS = 30_000;
const MAX_TRACKED_REPORTS = 50;

const recentReports = new Map<string, number>();
const SENSITIVE_PATTERN =
  /authorization\s*:\s*(?:bearer\s+)?\S+|bearer\s+[a-z0-9._-]{10,}/gi;

function redact(value: string): string {
  return value.replace(SENSITIVE_PATTERN, '[redacted]');
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeRoute(rawRoute: string): string {
  const withoutHash = rawRoute.split('#')[0];
  const withoutQuery = withoutHash.split('?')[0];
  return truncate(withoutQuery, FIELD_LIMITS.route);
}

function currentRoute(): string {
  return sanitizeRoute(`${window.location.pathname}${window.location.search}`);
}

function appVersion(): string {
  return truncate(
    import.meta.env.VITE_APP_VERSION ?? 'dev',
    FIELD_LIMITS.appVersion,
  );
}

export interface ClientErrorReport {
  message: string;
  stack?: string;
  route: string;
  requestId?: string;
  appVersion: string;
}

function buildReport(error: Error, route?: string): ClientErrorReport {
  const resolvedRoute =
    route !== undefined ? sanitizeRoute(route) : currentRoute();
  const message = truncate(
    redact(error.message || 'Unknown error'),
    FIELD_LIMITS.message,
  );
  const stack = error.stack
    ? truncate(redact(error.stack), FIELD_LIMITS.stack)
    : undefined;
  const requestId =
    error instanceof ApiError && error.requestId
      ? truncate(error.requestId, FIELD_LIMITS.requestId)
      : undefined;

  return {
    message,
    stack,
    route: resolvedRoute,
    requestId,
    appVersion: appVersion(),
  };
}

function reportKey(report: ClientErrorReport): string {
  return `${report.route}\u0000${report.message}`;
}

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const last = recentReports.get(key);
  recentReports.set(key, now);

  if (recentReports.size > MAX_TRACKED_REPORTS) {
    const oldestKey = recentReports.keys().next().value;
    if (oldestKey !== undefined) {
      recentReports.delete(oldestKey);
    }
  }

  return last !== undefined && now - last < DEDUPE_WINDOW_MS;
}

async function send(report: ClientErrorReport): Promise<void> {
  await request<void>('/client-errors', {
    method: 'POST',
    body: report,
    skipAuthRefresh: true,
  });
}

export function reportError(error: Error, route?: string): void {
  let report: ClientErrorReport;
  try {
    report = buildReport(error, route);
  } catch {
    return;
  }

  if (import.meta.env.DEV) {
    console.info('[client-errors] reporting error', report);
  }

  if (isDuplicate(reportKey(report))) {
    return;
  }

  send(report).catch(() => {});
}
