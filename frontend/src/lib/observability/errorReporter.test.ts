import { waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/msw/server';
import { SESSION_EXPIRED_EVENT } from '../api/client';
import { ApiError } from '../api/errors';
import { setAccessToken } from '../api/tokenStore';
import { reportError } from './errorReporter';

interface CapturedRequest {
  body: unknown;
  authorization: string | null;
}

function captureNextReport(): Promise<CapturedRequest> {
  return new Promise((resolve) => {
    server.use(
      http.post('/client-errors', async ({ request: msw }) => {
        resolve({
          body: await msw.json(),
          authorization: msw.headers.get('Authorization'),
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
  });
}

describe('reportError (Phase 27)', () => {
  beforeEach(() => {
    setAccessToken('live-access-token');
  });

  afterEach(() => {
    setAccessToken(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports the message, route, and app version for a plain error', async () => {
    const captured = captureNextReport();

    reportError(new Error('tile exploded'), '/app/assets/42');

    expect(await captured).toMatchObject({
      body: {
        message: 'tile exploded',
        route: '/app/assets/42',
        appVersion: expect.any(String),
      },
    });
  });

  it(
    'authenticates the request with the current access token, since the ' +
      'backend endpoint requires it (per-user identity and throttling)',
    async () => {
      const captured = captureNextReport();

      reportError(new Error('authenticated report'), '/app/assets/1');

      const { authorization } = await captured;
      expect(authorization).toBe('Bearer live-access-token');
    },
  );

  it('strips the query string and hash from the route before sending it', async () => {
    const captured = captureNextReport();

    reportError(
      new Error('route with query'),
      '/app/assets/42?tab=telemetry&from=overview#readings',
    );

    const { body } = await captured;
    expect((body as { route: string }).route).toBe('/app/assets/42');
  });

  it('defaults the route to the current location (query string stripped) when none is given', async () => {
    const original = window.location.href;
    window.history.pushState({}, '', '/app/work-orders?status=OPEN');
    const captured = captureNextReport();

    reportError(new Error('no explicit route'));

    const { body } = await captured;
    expect((body as { route: string }).route).toBe('/app/work-orders');

    window.history.pushState({}, '', original);
  });

  it('includes the requestId from an ApiError', async () => {
    const captured = captureNextReport();
    const apiError = new ApiError({
      status: 500,
      message: 'Database unavailable',
      requestId: 'req_789',
      path: '/work-orders',
    });

    reportError(apiError, '/app/work-orders');

    const { body } = await captured;
    expect((body as { requestId?: string }).requestId).toBe('req_789');
  });

  it('omits requestId for a plain error that never had one', async () => {
    const captured = captureNextReport();

    reportError(new Error('no request id here'), '/app/assets/1');

    const { body } = await captured;
    expect(body as object).not.toHaveProperty('requestId');
  });

  it('redacts an Authorization header or bearer token that ends up inside the message or stack', async () => {
    const captured = captureNextReport();
    const leaky = new Error(
      'failed while Authorization: Bearer abcdef1234567890.secret-token-value was attached',
    );
    leaky.stack =
      'Error: failed\n    at fetch (client.ts:1:1) Bearer abcdef1234567890xyz';

    reportError(leaky, '/app/assets/1');

    const { body } = await captured;
    const payload = body as { message: string; stack?: string };
    expect(payload.message).not.toContain('abcdef1234567890');
    expect(payload.message).not.toMatch(/bearer\s+[a-z0-9._-]{10,}/i);
    expect(payload.stack).not.toContain('abcdef1234567890xyz');
  });

  it('never includes the Authorization header value anywhere in the reported payload', async () => {
    const captured = captureNextReport();
    setAccessToken('super-secret-live-token-value');

    reportError(new Error('unrelated crash'), '/app/assets/1');

    const { body } = await captured;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('super-secret-live-token-value');
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });

  it('truncates fields that exceed the backend\u2019s length limits', async () => {
    const captured = captureNextReport();
    const longMessage = 'x'.repeat(1500);

    reportError(new Error(longMessage), '/app/assets/1');

    const { body } = await captured;
    expect((body as { message: string }).message.length).toBe(1000);
  });

  it('skips the 401 refresh/retry flow, so a stale token cannot log the user out as a side effect of reporting', async () => {
    const onSessionExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    let refreshCalls = 0;
    let clientErrorCalls = 0;

    server.use(
      http.post('/client-errors', () => {
        clientErrorCalls += 1;
        return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
      }),
      http.post('/auth/refresh', () => {
        refreshCalls += 1;
        return HttpResponse.json({ accessToken: 'fresh-access-token' });
      }),
    );

    reportError(new Error('crash with a stale token'), '/app/assets/1');

    await waitFor(() => expect(clientErrorCalls).toBe(1));
    expect(refreshCalls).toBe(0);
    expect(onSessionExpired).not.toHaveBeenCalled();

    window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  });

  it('never throws when the backend request rejects outright', async () => {
    server.use(http.post('/client-errors', () => HttpResponse.error()));

    expect(() =>
      reportError(new Error('network is down'), '/app/assets/1'),
    ).not.toThrow();

    // Give the rejected fetch a tick to be swallowed, so a future test
    // doesn't see it as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('never throws when the backend responds with 429 (throttled) or 500', async () => {
    server.use(
      http.post('/client-errors', () =>
        HttpResponse.json({ message: 'Too Many Requests' }, { status: 429 }),
      ),
    );

    expect(() =>
      reportError(new Error('throttled crash'), '/app/assets/2'),
    ).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('de-duplicates an identical report (same route and message) within the dedupe window', async () => {
    let calls = 0;
    server.use(
      http.post('/client-errors', () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    reportError(new Error('repeating render error'), '/app/assets/9');
    reportError(new Error('repeating render error'), '/app/assets/9');
    reportError(new Error('repeating render error'), '/app/assets/9');

    await waitFor(() => expect(calls).toBe(1));

    // give the deduped calls a chance to (not) land
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('reports again once the dedupe window has passed', async () => {
    let calls = 0;
    server.use(
      http.post('/client-errors', () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const nowSpy = vi.spyOn(Date, 'now');
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);

    reportError(new Error('error that recurs later'), '/app/assets/10');
    await waitFor(() => expect(calls).toBe(1));

    now += 31_000; // past the 30s dedupe window
    reportError(new Error('error that recurs later'), '/app/assets/10');
    await waitFor(() => expect(calls).toBe(2));
  });

  it('logs the report to the console in development', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const captured = captureNextReport();

    reportError(new Error('visible in dev console'), '/app/assets/1');
    await captured;

    expect(infoSpy).toHaveBeenCalledWith(
      '[client-errors] reporting error',
      expect.objectContaining({ message: 'visible in dev console' }),
    );
  });
});
