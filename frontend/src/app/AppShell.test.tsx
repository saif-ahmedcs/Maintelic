import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../test/msw/server';
import { signIn, signOut } from '../lib/auth/session';
import { AppShell } from './AppShell';
import AlertsPage from '../features/alerts/AlertsPage';
import OverviewPage from '../features/overview/OverviewPage';
import type { Notification } from '../features/alerts/api';

function mockSession(roles: string[]) {
  server.use(
    http.get('/auth/me', () =>
      HttpResponse.json({
        id: 'user-1',
        email: 'technician@plant.example',
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

function renderAppAtAlerts() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/alerts']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/alerts" element={<AlertsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderAppAtOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<OverviewPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockOverviewEndpoints() {
  const emptyPage = {
    data: [],
    meta: { page: 1, limit: 5, total: 0, totalPages: 0 },
  };
  server.use(
    http.get('/work-orders', () => HttpResponse.json(emptyPage)),
    http.get('/assets', () => HttpResponse.json(emptyPage)),
    http.get('/maintenance-plans/due', () => HttpResponse.json(emptyPage)),
    http.get('/spare-parts', () => HttpResponse.json(emptyPage)),
    http.get('/notifications', () => HttpResponse.json(emptyPage)),
  );
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    type: 'CRITICAL_ASSET',
    relatedEntityType: 'asset',
    relatedEntityId: 'asset-1',
    message: 'PUMP-01 exceeded the critical temperature threshold.',
    aiNote: null,
    status: 'UNREAD',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    resolvedByUserId: null,
    ...overrides,
  };
}

function mockNotificationsEndpoint(notification: Notification) {
  server.use(
    http.get('/notifications', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      const data =
        !status || notification.status === status ? [notification] : [];
      return HttpResponse.json({
        data,
        meta: {
          page: 1,
          limit: 20,
          total: data.length,
          totalPages: data.length ? 1 : 0,
        },
      });
    }),
    http.patch(`/notifications/${notification.id}/acknowledge`, () => {
      notification.status = 'ACKNOWLEDGED';
      return HttpResponse.json(notification);
    }),
  );
}

describe('AppShell + Overview — axe (17.1)', () => {
  it('has no axe violations on the loaded overview shell', async () => {
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockOverviewEndpoints();

    const { container } = renderAppAtOverview();

    await screen.findByText('No unread alerts right now.');
    await screen.findByText(/No open work orders/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AppShell nav — Users item visible only to ADMIN (Phase 21)', () => {
  it('shows the USERS nav item for an ADMIN', async () => {
    mockSession(['ADMIN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockOverviewEndpoints();

    renderAppAtOverview();

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('USERS')).toBeInTheDocument();
  });

  it('hides the USERS nav item for a non-admin', async () => {
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockOverviewEndpoints();

    renderAppAtOverview();

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('USERS')).not.toBeInTheDocument();
  });
});

describe('AppShell alert badge (14.4 / 14.5)', () => {
  it('shows the unread count and clears it once the alert is acknowledged', async () => {
    const user = userEvent.setup();
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });

    const notification = makeNotification();
    mockNotificationsEndpoint(notification);

    renderAppAtAlerts();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    await within(nav).findByText('1');

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => {
      expect(within(nav).queryByText('1')).not.toBeInTheDocument();
    });
  });
});

describe('AppShell dashboard background', () => {
  it('renders one decorative background that persists across route changes', async () => {
    const user = userEvent.setup();
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    server.use(
      http.get('/notifications', () =>
        HttpResponse.json({
          data: [],
          meta: { page: 1, limit: 5, total: 0, totalPages: 0 },
        }),
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<p>Overview content</p>} />
              <Route path="/assets" element={<p>Assets content</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const background = container.querySelector('[data-dashboard-background]');
    expect(background).toBeInTheDocument();
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(
      container.querySelectorAll('[data-dashboard-background]'),
    ).toHaveLength(1);

    await user.click(within(nav).getByText('ASSETS'));
    await screen.findByText('Assets content');

    expect(container.querySelector('[data-dashboard-background]')).toBe(
      background,
    );
  });
});

describe('AppShell sign out confirmation', () => {
  function renderAppWithLogin() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<p>Home page</p>} />
            </Route>
            <Route path="/login" element={<p>Login page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  function mockNotificationsOnly() {
    server.use(
      http.get('/notifications', () =>
        HttpResponse.json({
          data: [],
          meta: { page: 1, limit: 5, total: 0, totalPages: 0 },
        }),
      ),
    );
  }

  function trackLogout() {
    const calls = { count: 0 };
    server.use(
      http.post('/auth/logout', () => {
        calls.count += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return calls;
  }

  it('asks for confirmation instead of signing out immediately', async () => {
    const user = userEvent.setup();
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockNotificationsOnly();
    const logout = trackLogout();

    renderAppWithLogin();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    expect(dialog).toHaveTextContent('You will need to sign in again');
    expect(logout.count).toBe(0);
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('stays signed in when the person cancels', async () => {
    const user = userEvent.setup();
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockNotificationsOnly();
    const logout = trackLogout();

    renderAppWithLogin();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await user.click(screen.getByRole('button', { name: 'Stay signed in' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(logout.count).toBe(0);
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('signs out and returns to the login page once confirmed', async () => {
    const user = userEvent.setup();
    mockSession(['TECHNICIAN']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockNotificationsOnly();
    const logout = trackLogout();

    renderAppWithLogin();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(logout.count).toBe(1);
  });
});
