import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './errors';

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
