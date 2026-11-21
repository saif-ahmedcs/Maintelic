import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../test/msw/server';
import { signIn, signOut } from '../../lib/auth/session';
import AccountPage from './AccountPage';

interface MockUser {
  id: string;
  email: string;
  roles: string[];
  name?: string | null;
  mustChangePassword?: boolean;
}

function mockSession(user: MockUser) {
  server.use(http.get('/auth/me', () => HttpResponse.json(user)));
}

function mockLogoutOk() {
  server.use(
    http.post('/auth/logout', () => new HttpResponse(null, { status: 204 })),
  );
}

afterEach(async () => {
  mockLogoutOk();
  await signOut();
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountPage />
    </QueryClientProvider>,
  );
}

const BASE_USER: MockUser = {
  id: 'user-1',
  email: 'jordan.reyes@plant.example',
  name: 'Jordan Reyes',
  roles: ['TECHNICIAN'],
  mustChangePassword: false,
};

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  values: { current?: string; next?: string; confirm?: string },
) {
  if (values.current !== undefined) {
    await user.type(screen.getByLabelText('Current password'), values.current);
  }
  if (values.next !== undefined) {
    await user.type(screen.getByLabelText('New password'), values.next);
  }
  if (values.confirm !== undefined) {
    await user.type(
      screen.getByLabelText('Confirm new password'),
      values.confirm,
    );
  }
  await user.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('AccountPage', () => {
  describe('rendering the profile (22.1)', () => {
    it('shows the signed-in user’s name, email, and roles', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      renderPage();

      expect(
        await screen.findByRole('heading', { name: 'Jordan Reyes' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(BASE_USER.email, { selector: 'dd' }),
      ).toBeInTheDocument();
      expect(screen.getByText('TECHNICIAN')).toBeInTheDocument();
    });

    it('falls back to the email as the heading, and "Not set" for name, when the account has no name', async () => {
      mockSession({ ...BASE_USER, name: null });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      renderPage();

      expect(
        await screen.findByRole('heading', { name: BASE_USER.email }),
      ).toBeInTheDocument();
      expect(screen.getByText('Not set')).toBeInTheDocument();
    });

    it('shows multiple roles', async () => {
      mockSession({ ...BASE_USER, roles: ['ADMIN', 'SUPERVISOR'] });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      renderPage();

      await screen.findByRole('heading', { name: 'Jordan Reyes' });
      expect(screen.getByText('ADMIN')).toBeInTheDocument();
      expect(screen.getByText('SUPERVISOR')).toBeInTheDocument();
    });
  });

  describe('forced password change (22.3)', () => {
    it('shows a banner explaining the account must change its password', async () => {
      mockSession({ ...BASE_USER, mustChangePassword: true });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      renderPage();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'You must change your password before you can continue.',
      );
    });

    it('does not show the banner once a password change is not required', async () => {
      mockSession({ ...BASE_USER, mustChangePassword: false });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      renderPage();

      await screen.findByRole('heading', { name: 'Jordan Reyes' });
      expect(
        screen.queryByText(/must change your password/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('change-password validation (22.2)', () => {
    it('requires the current password', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        next: 'a-new-password-12',
        confirm: 'a-new-password-12',
      });

      expect(
        await screen.findByText('Current password is required'),
      ).toBeInTheDocument();
    });

    it('requires the new password to be at least 12 characters', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'short1!',
        confirm: 'short1!',
      });

      expect(
        await screen.findByText('New password must be at least 12 characters'),
      ).toBeInTheDocument();
    });

    it('requires the confirmation to match the new password', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'a-new-password-12',
        confirm: 'a-different-password',
      });

      expect(
        await screen.findByText('New password and confirmation do not match'),
      ).toBeInTheDocument();
    });

    it('requires the new password to differ from the current password', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'SamePassword123!',
        next: 'SamePassword123!',
        confirm: 'SamePassword123!',
      });

      expect(
        await screen.findByText(
          'New password must be different from the current password',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('change-password API integration (22.4)', () => {
    it('on success, clears the form and shows a notice that other sessions were signed out', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      let receivedBody: unknown;
      server.use(
        http.patch('/auth/password', async ({ request }) => {
          receivedBody = await request.json();
          return new HttpResponse(null, { status: 204 });
        }),
      );
      mockSession({ ...BASE_USER, mustChangePassword: false });

      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your password has been changed. Other sessions have been signed out.',
      );
      expect(receivedBody).toEqual({
        currentPassword: 'CorrectHorseBattery9!',
        newPassword: 'a-brand-new-password-12',
      });
      expect(screen.getByLabelText('Current password')).toHaveValue('');
      expect(screen.getByLabelText('New password')).toHaveValue('');
      expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
    });

    it('clears the forced-change banner once the password change succeeds', async () => {
      mockSession({ ...BASE_USER, mustChangePassword: true });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      server.use(
        http.patch(
          '/auth/password',
          () => new HttpResponse(null, { status: 204 }),
        ),
      );

      renderPage();
      await screen.findByText(/must change your password/i);

      mockSession({ ...BASE_USER, mustChangePassword: false });

      await fillAndSubmit(user, {
        current: 'TemporaryPassword9!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      await screen.findByRole('status');
      await waitFor(() =>
        expect(
          screen.queryByText(/must change your password/i),
        ).not.toBeInTheDocument(),
      );
    });

    it('shows "current password is incorrect" on the current-password field for a real password-check 401, without signing the user out', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      server.use(
        http.patch('/auth/password', () =>
          HttpResponse.json(
            {
              statusCode: 401,
              error: 'InvalidCurrentPassword',
              message: 'Current password is incorrect',
            },
            { status: 401 },
          ),
        ),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'WrongPassword123!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      expect(
        await screen.findByText('Current password is incorrect'),
      ).toBeInTheDocument();
      // It's a field-level error under "Current password", not a
      // form-level banner.
      expect(
        screen.queryByText('Something went wrong'),
      ).not.toBeInTheDocument();
      // Still signed in: the heading (which only renders for an
      // authenticated session) is still on screen.
      expect(
        screen.getByRole('heading', { name: 'Jordan Reyes' }),
      ).toBeInTheDocument();
    });

    it('treats a guard-level 401 (expired access token) as a session issue, not a wrong password (P1-2)', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      let refreshCalls = 0;
      server.use(
        http.patch('/auth/password', () =>
          HttpResponse.json(
            { statusCode: 401, message: 'Unauthorized' },
            {
              status: 401,
            },
          ),
        ),
        http.post('/auth/refresh', () => {
          refreshCalls += 1;
          return HttpResponse.json({ accessToken: 'refreshed-token' });
        }),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      expect(
        await screen.findByText(
          'Your session needed to be refreshed. Please try again.',
        ),
      ).toBeInTheDocument();
      // Crucially, this must never be attributed to the current-password
      // field, or shown as "Current password is incorrect".
      expect(screen.queryByLabelText('Current password')).toHaveValue(
        'CorrectHorseBattery9!',
      );
      expect(
        screen.queryByText('Current password is incorrect'),
      ).not.toBeInTheDocument();
      // Still signed in — and we actually refreshed the token in the
      // background rather than just showing an error.
      expect(
        screen.getByRole('heading', { name: 'Jordan Reyes' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(refreshCalls).toBe(1));
    });

    it('signs the user out if the refresh token has also expired after a guard-level 401 (P1-2)', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      server.use(
        http.patch('/auth/password', () =>
          HttpResponse.json(
            { statusCode: 401, message: 'Unauthorized' },
            {
              status: 401,
            },
          ),
        ),
        http.post('/auth/refresh', () =>
          HttpResponse.json(
            { statusCode: 401, message: 'Refresh token has expired' },
            { status: 401 },
          ),
        ),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      await waitFor(() =>
        expect(
          screen.queryByRole('heading', { name: 'Jordan Reyes' }),
        ).not.toBeInTheDocument(),
      );
    });

    it('shows a generic form error for an unexpected server failure', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      server.use(
        http.patch(
          '/auth/password',
          () => new HttpResponse(null, { status: 500 }),
        ),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      await fillAndSubmit(user, {
        current: 'CorrectHorseBattery9!',
        next: 'a-brand-new-password-12',
        confirm: 'a-brand-new-password-12',
      });

      expect(
        await screen.findByText('Something went wrong on our side.'),
      ).toBeInTheDocument();
    });
  });

  describe('accessibility (17.1)', () => {
    it('has no axe violations', async () => {
      mockSession(BASE_USER);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      const { container } = renderPage();
      await screen.findByRole('heading', { name: 'Jordan Reyes' });

      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations with the forced-change banner and a field error shown', async () => {
      mockSession({ ...BASE_USER, mustChangePassword: true });
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const user = userEvent.setup();

      const { container } = renderPage();
      await screen.findByText(/must change your password/i);

      await fillAndSubmit(user, { next: 'short', confirm: 'short' });
      await screen.findByText('Current password is required');

      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
