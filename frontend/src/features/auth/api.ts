import { z } from 'zod';
import { request } from '../../lib/api/client';

export const roleSchema = z.enum([
  'ADMIN',
  'SUPERVISOR',
  'TECHNICIAN',
  'VIEWER',
]);
export type Role = z.infer<typeof roleSchema>;

const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  roles: z.array(roleSchema),
  name: z.string().nullable().optional(),
  mustChangePassword: z.boolean().optional(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export interface LoginParams {
  email: string;
  password: string;
}

/* POST /auth/login */
export async function login(params: LoginParams): Promise<AuthTokens> {
  const data = await request<unknown>('/auth/login', {
    method: 'POST',
    body: params,
    skipAuthRefresh: true,
  });
  return authTokensSchema.parse(data);
}

/* GET /auth/me. */
export async function getMe(): Promise<AuthUser> {
  const data = await request<unknown>('/auth/me');
  return authUserSchema.parse(data);
}

/* POST /auth/logout */
export async function logout(): Promise<void> {
  await request<void>('/auth/logout', {
    method: 'POST',
    skipAuthRefresh: true,
  });
}
