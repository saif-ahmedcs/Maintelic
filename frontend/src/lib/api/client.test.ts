import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/msw/server';
import { request, SESSION_EXPIRED_EVENT } from './client';
import { ApiError, NetworkError } from './errors';
import { getAccessToken, setAccessToken } from './tokenStore';

describe('request', () => {
  beforeEach(() => {
    setAccessToken('stale-access-token');
  });

  afterEach(() => {
    setAccessToken(null);
  });

  it('refreshes once and retries once after a single 401', async () => {
    let thingCalls = 0;
    let refreshCalls = 0;

    server.use(
      http.get('/thing', () => {
        thingCalls += 1;
        if (thingCalls === 1) {
          return HttpResponse.json(
            { message: 'Unauthorized' },
            { status: 401 },
          );
        }
        return HttpResponse.json({ ok: true });
      }),
      http.post('/auth/refresh', () => {
        refreshCalls += 1;
        return HttpResponse.json({ accessToken: 'fresh-access-token' });
      }),
    );

    const result = await request<{ ok: boolean }>('/thing');

    expect(result).toEqual({ ok: true });
    expect(thingCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('logs out when the retried request also gets a 401', async () => {
    let thingCalls = 0;
    let refreshCalls = 0;
    const onSessionExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);

    server.use(
      http.get('/thing', () => {
        thingCalls += 1;
        return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
      }),
      http.post('/auth/refresh', () => {
        refreshCalls += 1;
        return HttpResponse.json({ accessToken: 'fresh-access-token' });
      }),
    );

    await expect(request('/thing')).rejects.toMatchObject({ status: 401 });

    expect(thingCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);

    window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  });

  it('does not log out when the refresh attempt fails due to a network error (P1-1)', async () => {
    let thingCalls = 0;
    let refreshCalls = 0;
    const onSessionExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);

    server.use(
      http.get('/thing', () => {
        thingCalls += 1;
        return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
      }),
      http.post('/auth/refresh', () => {
        refreshCalls += 1;
        return HttpResponse.error();
      }),
    );

    await expect(request('/thing')).rejects.toBeInstanceOf(NetworkError);

    expect(thingCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('stale-access-token');

    window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  });

  it.each([429, 500, 502, 503, 504])(
    'does not log out when the refresh attempt returns a transient %i (AUTH-1)',
    async (status) => {
      let thingCalls = 0;
      let refreshCalls = 0;
      const onSessionExpired = vi.fn();
      window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);

      server.use(
        http.get('/thing', () => {
          thingCalls += 1;
          return HttpResponse.json(
            { message: 'Unauthorized' },
            { status: 401 },
          );
        }),
        http.post('/auth/refresh', () => {
          refreshCalls += 1;
          return HttpResponse.json({ message: 'Unavailable' }, { status });
        }),
      );

      const error = await request('/thing').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status });
      expect(thingCalls).toBe(1);
      expect(refreshCalls).toBe(1);
      expect(onSessionExpired).not.toHaveBeenCalled();
      expect(getAccessToken()).toBe('stale-access-token');

      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    },
  );

  it('still logs out when the refresh endpoint definitively rejects with 401 (AUTH-1)', async () => {
    const onSessionExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);

    server.use(
      http.get('/thing', () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 }),
      ),
      http.post('/auth/refresh', () =>
        HttpResponse.json({ message: 'Invalid refresh token' }, { status: 401 }),
      ),
    );

    await expect(request('/thing')).rejects.toMatchObject({ status: 401 });

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();

    window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  });

  it('rejects with a NetworkError, not a generic throw, when the server is unreachable (P1-1)', async () => {
    server.use(http.get('/thing', () => HttpResponse.error()));

    const error = await request('/thing').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
  });

  it('omits undefined query parameters', async () => {
    let capturedUrl: URL | undefined;

    server.use(
      http.get('/things', ({ request: msw }) => {
        capturedUrl = new URL(msw.url);
        return HttpResponse.json({ ok: true });
      }),
    );

    await request('/things', {
      query: { status: 'OPEN', limit: undefined, page: 2 },
    });

    expect(capturedUrl?.searchParams.get('status')).toBe('OPEN');
    expect(capturedUrl?.searchParams.get('page')).toBe('2');
    expect(capturedUrl?.searchParams.has('limit')).toBe(false);
  });
});
