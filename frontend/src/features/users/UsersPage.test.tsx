import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../test/msw/server';
import { signIn, signOut } from '../../lib/auth/session';
import { RequireRole } from '../../app/RequireRole';
import UsersPage from './UsersPage';
import type { User } from './api';

function mockSession(roles: string[]) {
  server.use(
    http.get('/auth/me', () =>
      HttpResponse.json({
        id: 'user-current',
        email: 'admin@plant.example',
        roles,
      }),
    ),
  );
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
      <MemoryRouter initialEntries={['/app/users']}>
        <UsersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeUser(overrides: Partial<User>): User {
  return {
    id: 'user-1',
    email: 'user@plant.example',
    name: 'Plant User',
    isActive: true,
    roles: ['VIEWER'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockUsersList(users: User[]) {
  server.use(
    http.get('/users', ({ request }) => {
      const url = new URL(request.url);
      const role = url.searchParams.get('role');
      const active = url.searchParams.get('active');

      let filtered = users;
      if (role) {
        filtered = filtered.filter((u) => u.roles.includes(role as never));
      }
      if (active !== null) {
        const wantActive = active === 'true';
        filtered = filtered.filter((u) => u.isActive === wantActive);
      }

      return HttpResponse.json({
        data: filtered,
        meta: { page: 1, limit: 20, total: filtered.length, totalPages: 1 },
      });
    }),
  );
}

describe('UsersPage', () => {
  it('has no axe violations when the list is loaded (17.1)', async () => {
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([makeUser({})]);

    const { container } = renderPage();
    await screen.findByRole('row', { name: /user@plant\.example/ });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders each user’s roles as tags and their active state, without a last-sign-in column', async () => {
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({
        id: 'user-active',
        email: 'holly@plant.example',
        roles: ['ADMIN', 'SUPERVISOR'],
        isActive: true,
      }),
      makeUser({
        id: 'user-inactive',
        email: 'dormant@plant.example',
        roles: ['TECHNICIAN'],
        isActive: false,
      }),
    ]);

    renderPage();

    const activeRow = await screen.findByRole('row', {
      name: /holly@plant\.example/,
    });
    expect(within(activeRow).getByText('ADMIN')).toBeInTheDocument();
    expect(within(activeRow).getByText('SUPERVISOR')).toBeInTheDocument();
    expect(within(activeRow).getByText('ACTIVE')).toBeInTheDocument();

    const inactiveRow = screen.getByRole('row', {
      name: /dormant@plant\.example/,
    });
    expect(within(inactiveRow).getByText('TECHNICIAN')).toBeInTheDocument();
    expect(within(inactiveRow).getByText('INACTIVE')).toBeInTheDocument();

    expect(
      screen.queryByRole('columnheader', { name: /last sign.?in/i }),
    ).not.toBeInTheDocument();
  });

  it('filters the list by role through the API', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({
        id: 'u-admin',
        email: 'admin2@plant.example',
        roles: ['ADMIN'],
      }),
      makeUser({
        id: 'u-tech',
        email: 'tech@plant.example',
        roles: ['TECHNICIAN'],
      }),
    ]);

    renderPage();
    await screen.findByRole('row', { name: /admin2@plant\.example/ });
    expect(
      screen.getByRole('row', { name: /tech@plant\.example/ }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Role'), 'TECHNICIAN');

    await waitFor(() => {
      expect(
        screen.queryByRole('row', { name: /admin2@plant\.example/ }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('row', { name: /tech@plant\.example/ }),
    ).toBeInTheDocument();
  });

  it('filters the list by active status through the API', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({
        id: 'u-active',
        email: 'holly3@plant.example',
        isActive: true,
      }),
      makeUser({
        id: 'u-inactive',
        email: 'dormant3@plant.example',
        isActive: false,
      }),
    ]);

    renderPage();
    await screen.findByRole('row', { name: /holly3@plant\.example/ });

    await user.selectOptions(screen.getByLabelText('Status'), 'false');

    await waitFor(() => {
      expect(
        screen.queryByRole('row', { name: /holly3@plant\.example/ }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('row', { name: /dormant3@plant\.example/ }),
    ).toBeInTheDocument();
  });

  it('creates a user, shows the temporary password once, and never shows it again after closing', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([]);

    server.use(
      http.post('/users', () =>
        HttpResponse.json({
          id: 'user-new',
          email: 'new.hire@plant.example',
          name: 'New Hire',
          isActive: true,
          roles: ['TECHNICIAN'],
          createdAt: '2026-01-01T00:00:00.000Z',
          temporaryPassword: 'One-Time-Pass-1',
        }),
      ),
    );

    renderPage();
    await screen.findByText('No users yet. Add one to get started.');

    await user.click(screen.getByRole('button', { name: 'Add user' }));
    const createDialog = await screen.findByRole('dialog', {
      name: 'Add user',
    });
    await user.type(within(createDialog).getByLabelText('Name'), 'New Hire');
    await user.type(
      within(createDialog).getByLabelText('Email'),
      'new.hire@plant.example',
    );
    await user.click(
      within(createDialog).getByRole('checkbox', { name: 'TECHNICIAN' }),
    );
    await user.click(
      within(createDialog).getByRole('button', { name: 'Add user' }),
    );

    expect(
      screen.queryByRole('dialog', { name: 'Add user' }),
    ).not.toBeInTheDocument();

    const passwordDialog = await screen.findByRole('dialog', {
      name: 'Temporary password',
    });
    expect(
      within(passwordDialog).getByText('One-Time-Pass-1'),
    ).toBeInTheDocument();

    await user.click(
      within(passwordDialog).getByRole('button', { name: 'Done' }),
    );

    expect(
      screen.queryByRole('dialog', { name: 'Temporary password' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('One-Time-Pass-1')).not.toBeInTheDocument();
  });

  it('deactivates an active user after confirmation', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({ id: 'u-1', email: 'toggle@plant.example', isActive: true }),
    ]);

    let deactivated = false;
    server.use(
      http.patch('/users/u-1', async ({ request }) => {
        const body = (await request.json()) as { active?: boolean };
        deactivated = body.active === false;
        return HttpResponse.json(
          makeUser({
            id: 'u-1',
            email: 'toggle@plant.example',
            isActive: false,
          }),
        );
      }),
    );

    renderPage();
    const row = await screen.findByRole('row', {
      name: /toggle@plant\.example/,
    });
    await user.click(within(row).getByRole('button', { name: 'Deactivate' }));

    const dialog = await screen.findByRole('dialog', {
      name: /Deactivate/,
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Deactivate' }),
    );

    await waitFor(() => expect(deactivated).toBe(true));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('reactivates an inactive user after confirmation', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({
        id: 'u-2',
        email: 'bring-back@plant.example',
        isActive: false,
      }),
    ]);

    server.use(
      http.patch('/users/u-2', () =>
        HttpResponse.json(
          makeUser({
            id: 'u-2',
            email: 'bring-back@plant.example',
            isActive: true,
          }),
        ),
      ),
    );

    renderPage();
    const row = await screen.findByRole('row', {
      name: /bring-back@plant\.example/,
    });
    await user.click(within(row).getByRole('button', { name: 'Reactivate' }));

    const dialog = await screen.findByRole('dialog', { name: /Reactivate/ });
    await user.click(
      within(dialog).getByRole('button', { name: 'Reactivate' }),
    );

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('shows the server’s 409 message and keeps the confirm dialog open when deactivating the last admin', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([
      makeUser({
        id: 'u-last-admin',
        email: 'lastadmin@plant.example',
        roles: ['ADMIN'],
      }),
    ]);

    server.use(
      http.patch('/users/u-last-admin', () =>
        HttpResponse.json(
          { message: 'At least one active admin is required.' },
          { status: 409 },
        ),
      ),
    );

    renderPage();
    const row = await screen.findByRole('row', {
      name: /lastadmin@plant\.example/,
    });
    await user.click(within(row).getByRole('button', { name: 'Deactivate' }));

    const dialog = await screen.findByRole('dialog', { name: /Deactivate/ });
    await user.click(
      within(dialog).getByRole('button', { name: 'Deactivate' }),
    );

    expect(
      await screen.findByText('At least one active admin is required.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('resets a user’s password and shows the new temporary password once', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockUsersList([makeUser({ id: 'u-3', email: 'reset.me@plant.example' })]);

    server.use(
      http.post('/users/u-3/reset-password', () =>
        HttpResponse.json({
          ...makeUser({ id: 'u-3', email: 'reset.me@plant.example' }),
          temporaryPassword: 'Fresh-Pass-99',
        }),
      ),
    );

    renderPage();
    const row = await screen.findByRole('row', {
      name: /reset\.me@plant\.example/,
    });
    await user.click(
      within(row).getByRole('button', { name: 'Reset password' }),
    );

    const confirmDialog = await screen.findByRole('dialog', {
      name: /Reset password for/,
    });
    await user.click(
      within(confirmDialog).getByRole('button', { name: 'Reset password' }),
    );

    const passwordDialog = await screen.findByRole('dialog', {
      name: 'Temporary password',
    });
    expect(
      within(passwordDialog).getByText('Fresh-Pass-99'),
    ).toBeInTheDocument();
  });

  it('shows an error state with a retry option when the list fails to load', async () => {
    const user = userEvent.setup();
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });

    let attempts = 0;
    server.use(
      http.get('/users', () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { message: 'Something went wrong on our side.' },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          data: [makeUser({})],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        });
      }),
    );

    renderPage();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByRole('row', { name: /user@plant\.example/ });
    expect(attempts).toBe(2);
  });

  it('redirects a non-admin away from the Users page (Phase 21.7)', async () => {
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/app/users']}>
          <Routes>
            <Route
              path="/app/users"
              element={
                <RequireRole roles={['ADMIN']}>
                  <UsersPage />
                </RequireRole>
              }
            />
            <Route path="/not-permitted" element={<div>not permitted</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('not permitted')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add user' }),
    ).not.toBeInTheDocument();
  });
});
