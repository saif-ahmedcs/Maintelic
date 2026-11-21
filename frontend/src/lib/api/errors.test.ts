import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, isTransientFailure } from './errors';

describe('ApiError.fromResponse', () => {
  it('carries the request ID from the error body', async () => {
    const response = new Response(
      JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: 'Cannot transition work order from COMPLETED to IN_PROGRESS',
        path: '/work-orders/abc/start',
        requestId: 'req-abc-123',
      }),
      { status: 409 },
    );

    const error = await ApiError.fromResponse(
      response,
      '/work-orders/abc/start',
    );

    expect(error.requestId).toBe('req-abc-123');
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      'Cannot transition work order from COMPLETED to IN_PROGRESS',
    );
  });

  it('joins an array of validation messages into the error message', async () => {
    const response = new Response(
      JSON.stringify({
        statusCode: 400,
        error: 'Bad Request',
        message: [
          'email must be an email',
          'password must be longer than 8 characters',
        ],
      }),
      { status: 400 },
    );

    const error = await ApiError.fromResponse(response, '/auth/register');

    expect(error.message).toBe(
      'email must be an email password must be longer than 8 characters',
    );
    expect(error.validationMessages).toEqual([
      'email must be an email',
      'password must be longer than 8 characters',
    ]);
  });

  it("captures the backend's `error` field as `code`, so two different causes of the same status can be told apart (P1-2)", async () => {
    const wrongPassword = await ApiError.fromResponse(
      new Response(
        JSON.stringify({
          statusCode: 401,
          error: 'InvalidCurrentPassword',
          message: 'Current password is incorrect',
        }),
        { status: 401 },
      ),
      '/auth/password',
    );
    const expiredToken = await ApiError.fromResponse(
      new Response(
        JSON.stringify({ statusCode: 401, message: 'Unauthorized' }),
        {
          status: 401,
        },
      ),
      '/auth/password',
    );

    expect(wrongPassword.code).toBe('InvalidCurrentPassword');
    expect(expiredToken.code).toBeUndefined();
    expect(wrongPassword.status).toBe(expiredToken.status);
    expect(wrongPassword.code).not.toBe(expiredToken.code);
  });
});

describe('NetworkError', () => {
  it('is not an ApiError, and vice versa', () => {
    const networkError = new NetworkError('/auth/refresh');
    const apiError = new ApiError({
      status: 401,
      message: 'Unauthorized',
      path: '/auth/refresh',
    });

    expect(networkError).toBeInstanceOf(NetworkError);
    expect(networkError).not.toBeInstanceOf(ApiError);
    expect(apiError).toBeInstanceOf(ApiError);
    expect(apiError).not.toBeInstanceOf(NetworkError);
  });

  it('carries the path and the original thrown value as cause', () => {
    const cause = new TypeError('Failed to fetch');

    const error = new NetworkError('/auth/refresh', { cause });

    expect(error.name).toBe('NetworkError');
    expect(error.path).toBe('/auth/refresh');
    expect(error.cause).toBe(cause);
  });
});

describe('isTransientFailure', () => {
  const apiError = (status: number) =>
    new ApiError({ status, message: 'x', path: '/auth/refresh' });

  it('treats network errors as transient', () => {
    expect(isTransientFailure(new NetworkError('/auth/refresh'))).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'treats HTTP %i as transient',
    (status) => {
      expect(isTransientFailure(apiError(status))).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 409])(
    'does not treat HTTP %i as transient',
    (status) => {
      expect(isTransientFailure(apiError(status))).toBe(false);
    },
  );

  it('does not treat arbitrary errors as transient', () => {
    expect(isTransientFailure(new Error('boom'))).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
  });
});
