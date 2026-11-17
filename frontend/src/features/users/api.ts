import { z } from 'zod';
import { request, type QueryParams } from '../../lib/api/client';
import { paginated } from '../../lib/api/pagination';
import { roleSchema, type Role } from '../auth/api';

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  isActive: z.boolean(),
  roles: z.array(roleSchema),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

const createUserResponseSchema = userSchema.extend({
  temporaryPassword: z.string(),
});

export interface TemporaryPasswordResult {
  user: User;
  temporaryPassword: string;
}

function parseCreateUserResponse(data: unknown): TemporaryPasswordResult {
  const parsed = createUserResponseSchema.parse(data);
  const { temporaryPassword, ...user } = parsed;
  return { user, temporaryPassword };
}

export interface ListUsersParams extends QueryParams {
  page?: number;
  limit?: number;
  role?: Role;
  active?: boolean;
  sortBy?: string;
  sortDir?: 'ASC' | 'DESC' | 'asc' | 'desc';
}

/** GET /users (ADMIN) */
export async function listUsers(params: ListUsersParams = {}) {
  const data = await request<unknown>('/users', { query: params });
  return paginated(userSchema).parse(data);
}

export interface CreateUserInput {
  email: string;
  name: string;
  roles: Role[];
}

/* POST /users (ADMIN). */
export async function createUser(
  input: CreateUserInput,
): Promise<TemporaryPasswordResult> {
  const data = await request<unknown>('/users', {
    method: 'POST',
    body: input,
  });
  return parseCreateUserResponse(data);
}

export interface UpdateUserInput {
  name?: string;
  active?: boolean;
}

/* PATCH /users/:id (ADMIN). */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
): Promise<User> {
  const data = await request<unknown>(`/users/${id}`, {
    method: 'PATCH',
    body: input,
  });
  return userSchema.parse(data);
}

/* PUT /users/:id/roles (ADMIN). */
export async function updateUserRoles(
  id: string,
  roles: Role[],
): Promise<User> {
  const data = await request<unknown>(`/users/${id}/roles`, {
    method: 'PUT',
    body: { roles },
  });
  return userSchema.parse(data);
}

/* POST /users/:id/reset-password (ADMIN).*/
export async function resetUserPassword(
  id: string,
): Promise<TemporaryPasswordResult> {
  const data = await request<unknown>(`/users/${id}/reset-password`, {
    method: 'POST',
  });
  return parseCreateUserResponse(data);
}
