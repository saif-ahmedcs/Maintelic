import { HttpResponse, http } from 'msw';
import type { RequestHandler } from 'msw';

export const handlers: RequestHandler[] = [
  http.post('/client-errors', () => new HttpResponse(null, { status: 204 })),
];
