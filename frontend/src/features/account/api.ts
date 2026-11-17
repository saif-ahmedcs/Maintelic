import { request } from '../../lib/api/client';

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/* PATCH /auth/password */
export async function changePassword(
  input: ChangePasswordInput,
): Promise<void> {
  await request<void>('/auth/password', {
    method: 'PATCH',
    body: input,
    skipAuthRefresh: true,
  });
}
