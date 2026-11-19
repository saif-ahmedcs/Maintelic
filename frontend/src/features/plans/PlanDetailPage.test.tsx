import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../test/msw/server';
import { signIn, signOut } from '../../lib/auth/session';
import { formatDateTime } from '../../lib/format';
import PlanDetailPage from './PlanDetailPage';
import type { Asset } from '../assets/api';
import type { WorkOrder } from '../work-orders/api';
import type { MaintenancePlanDetail } from './api';

function mockSession(roles: string[]) {
  server.use(
    http.get('/auth/me', () =>
      HttpResponse.json({
        id: 'user-1',
        email: 'supervisor@plant.example',
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

function renderPage(initialEntries: string[] = ['/app/plans/plan-1']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/app/plans/:id" element={<PlanDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    assetTypeId: 'type-1',
    locationId: 'location-1',
    tag: 'PUMP-01',
    manufacturer: 'Grundfos',
    model: 'CR 15',
    criticality: 'HIGH',
    status: 'OPERATIONAL',
    installedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlan(
  overrides: Partial<MaintenancePlanDetail> = {},
): MaintenancePlanDetail {
  return {
    id: 'plan-1',
    assetId: 'asset-1',
    name: 'Quarterly lubrication',
    intervalDays: 90,
    lastCompletedAt: null,
    nextDueAt: '2026-12-01T00:00:00.000Z',
    active: true,
    tasks: [],
    ...overrides,
  };
}

function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-1',
    assetId: 'asset-1',
    maintenancePlanId: 'plan-1',
    status: 'OPEN',
    source: 'PLANNED',
    priority: 'MEDIUM',
    assignedToUserId: null,
    description: 'Quarterly lubrication round',
    openedAt: '2026-01-01T08:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    totalCost: null,
    aiNote: null,
    blockReason: null,
    parts: [],
    ...overrides,
  };
}

function emptyPage(limit = 10) {
  return { data: [], meta: { page: 1, limit, total: 0, totalPages: 0 } };
}

function workOrdersPage(
  workOrders: WorkOrder[],
  meta: Partial<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> = {},
) {
  return {
    data: workOrders,
    meta: {
      page: 1,
      limit: 10,
      total: workOrders.length,
      totalPages: 1,
      ...meta,
    },
  };
}

function mockPlanEndpoints(
  plan: MaintenancePlanDetail,
  asset: Asset,
  workOrders: WorkOrder[] = [],
) {
  server.use(
    http.get(`/maintenance-plans/${plan.id}`, () => HttpResponse.json(plan)),
    http.get(`/assets/${asset.id}`, () => HttpResponse.json(asset)),
    http.get('/work-orders', () =>
      HttpResponse.json(workOrdersPage(workOrders)),
    ),
  );
}

describe('PlanDetailPage', () => {
  it('renders the header (name, asset link, interval, next due, active state) and no axe violations (24.1)', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockPlanEndpoints(makePlan({}), makeAsset({}));

    const { container } = renderPage();

    await screen.findByRole('heading', { name: 'Quarterly lubrication' });

    const assetLink = await screen.findByRole('link', { name: 'PUMP-01' });
    expect(assetLink).toHaveAttribute('href', '/assets/asset-1');

    expect(screen.getByText('90 days')).toBeInTheDocument();
    expect(
      screen.getByText(formatDateTime('2026-12-01T00:00:00.000Z')),
    ).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows "Never" when the plan has not yet been completed', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockPlanEndpoints(makePlan({ lastCompletedAt: null }), makeAsset({}));

    renderPage();

    await screen.findByRole('heading', { name: 'Quarterly lubrication' });
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  describe('OVERDUE tag (24.5)', () => {
    it('shows OVERDUE MAINTENANCE when the plan is active and past its next-due date', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const yesterday = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      mockPlanEndpoints(
        makePlan({ active: true, nextDueAt: yesterday }),
        makeAsset({}),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(screen.getByText('OVERDUE MAINTENANCE')).toBeInTheDocument();
    });

    it('does not show OVERDUE MAINTENANCE when the next-due date is in the future', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      mockPlanEndpoints(
        makePlan({ active: true, nextDueAt: tomorrow }),
        makeAsset({}),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(screen.queryByText('OVERDUE MAINTENANCE')).not.toBeInTheDocument();
    });

    it('does not show OVERDUE MAINTENANCE for an inactive plan, even if past its next-due date', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const yesterday = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      mockPlanEndpoints(
        makePlan({ active: false, nextDueAt: yesterday }),
        makeAsset({}),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(screen.getByText('INACTIVE')).toBeInTheDocument();
      expect(screen.queryByText('OVERDUE MAINTENANCE')).not.toBeInTheDocument();
    });
  });

  describe('Tasks (24.2)', () => {
    it('renders the ordered task list as provided by the server', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(
        makePlan({
          tasks: [
            { id: 'task-1', description: 'Check lubrication', orderIndex: 0 },
            { id: 'task-2', description: 'Inspect seals', orderIndex: 1 },
            { id: 'task-3', description: 'Replace filter', orderIndex: 2 },
          ],
        }),
        makeAsset({}),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      const rows = screen.getAllByRole('row');
      // rows[0] is the header row.
      expect(within(rows[1]).getByText('1')).toBeInTheDocument();
      expect(
        within(rows[1]).getByText('Check lubrication'),
      ).toBeInTheDocument();
      expect(within(rows[2]).getByText('2')).toBeInTheDocument();
      expect(within(rows[2]).getByText('Inspect seals')).toBeInTheDocument();
      expect(within(rows[3]).getByText('3')).toBeInTheDocument();
      expect(within(rows[3]).getByText('Replace filter')).toBeInTheDocument();
    });

    it('shows "No tasks defined for this plan yet." when the plan has no tasks', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({ tasks: [] }), makeAsset({}));

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(
        screen.getByText('No tasks defined for this plan yet.'),
      ).toBeInTheDocument();
    });
  });

  describe('Work order history (24.3)', () => {
    it('lists work orders raised from this plan, with reference and status', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}), [
        makeWorkOrder({ id: 'wo-1', status: 'OPEN', description: 'Round one' }),
      ]);

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      const row = await screen.findByRole('row', { name: /Round one/ });
      expect(within(row).getByText('#WO-1')).toBeInTheDocument();
      expect(within(row).getByText('OPEN')).toBeInTheDocument();
    });

    it('navigates to the work order detail page when a history row is clicked', async () => {
      const user = userEvent.setup();
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}), [
        makeWorkOrder({ id: 'wo-1', status: 'OPEN', description: 'Round one' }),
      ]);

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      render(
        <QueryClientProvider client={queryClient}>
          {/* `PlanDetailPage` navigates with an absolute, basename-relative
              path (`navigate('/work-orders/...')`), exactly like the real
              `BrowserRouter basename="/app"` in router.tsx, so this test
              mirrors that basename instead of nesting routes under /app. */}
          <MemoryRouter basename="/app" initialEntries={['/app/plans/plan-1']}>
            <Routes>
              <Route path="/plans/:id" element={<PlanDetailPage />} />
              <Route
                path="/work-orders/:id"
                element={<p>Work order detail stub</p>}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      const row = await screen.findByRole('row', { name: /Round one/ });
      await user.click(row);

      await screen.findByText('Work order detail stub');
    });

    it('shows "No work orders have been raised from this plan yet." when there is no history', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}), []);

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(
        await screen.findByText(
          'No work orders have been raised from this plan yet.',
        ),
      ).toBeInTheDocument();
    });

    it('paginates the work order history', async () => {
      const user = userEvent.setup();
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      const plan = makePlan({});
      const asset = makeAsset({});
      server.use(
        http.get(`/maintenance-plans/${plan.id}`, () =>
          HttpResponse.json(plan),
        ),
        http.get(`/assets/${asset.id}`, () => HttpResponse.json(asset)),
        http.get('/work-orders', ({ request }) => {
          const url = new URL(request.url);
          const page = url.searchParams.get('page') ?? '1';
          const workOrder =
            page === '2'
              ? makeWorkOrder({ id: 'wo-page-2', description: 'Round two' })
              : makeWorkOrder({ id: 'wo-page-1', description: 'Round one' });
          return HttpResponse.json(
            workOrdersPage([workOrder], {
              page: Number(page),
              totalPages: 2,
              total: 2,
            }),
          );
        }),
      );

      renderPage();

      await screen.findByRole('row', { name: /Round one/ });
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByRole('row', { name: /Round two/ });
    });

    it('shows a retryable error state for the work order history independent of the loaded plan', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const plan = makePlan({});
      const asset = makeAsset({});
      server.use(
        http.get(`/maintenance-plans/${plan.id}`, () =>
          HttpResponse.json(plan),
        ),
        http.get(`/assets/${asset.id}`, () => HttpResponse.json(asset)),
        http.get('/work-orders', () =>
          HttpResponse.json({ message: 'Boom' }, { status: 500 }),
        ),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Retry' }),
      ).toBeInTheDocument();
    });
  });

  describe('Role gating (24.4)', () => {
    it('hides Edit for a VIEWER', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}));

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(
        screen.queryByRole('button', { name: 'Edit' }),
      ).not.toBeInTheDocument();
    });

    it('hides Edit for a TECHNICIAN', async () => {
      mockSession(['TECHNICIAN']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}));

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(
        screen.queryByRole('button', { name: 'Edit' }),
      ).not.toBeInTheDocument();
    });

    it('offers Edit for a SUPERVISOR, which opens the existing edit dialog', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}));

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      await user.click(screen.getByRole('button', { name: 'Edit' }));

      const dialog = await screen.findByRole('dialog', {
        name: 'Edit Quarterly lubrication',
      });
      expect(within(dialog).getByLabelText('Name')).toHaveValue(
        'Quarterly lubrication',
      );
      expect(within(dialog).getByLabelText('Status')).toHaveValue('true');
    });

    it('offers Edit for an ADMIN', async () => {
      mockSession(['ADMIN']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockPlanEndpoints(makePlan({}), makeAsset({}));

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });

    it('refetches the plan after a successful edit (reusing EditPlanDialog)', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      const plan = makePlan({});
      const asset = makeAsset({});
      let currentPlan = plan;
      server.use(
        http.get(`/maintenance-plans/${plan.id}`, () =>
          HttpResponse.json(currentPlan),
        ),
        http.get(`/assets/${asset.id}`, () => HttpResponse.json(asset)),
        http.get('/work-orders', () => HttpResponse.json(emptyPage())),
        http.patch(`/maintenance-plans/${plan.id}`, async ({ request }) => {
          const body = (await request.json()) as { active: boolean };
          currentPlan = { ...currentPlan, active: body.active };
          return HttpResponse.json(currentPlan);
        }),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Quarterly lubrication' });
      expect(screen.getByText('ACTIVE')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Edit Quarterly lubrication',
      });
      await user.selectOptions(
        within(dialog).getByLabelText('Status'),
        'Inactive',
      );
      await user.click(
        within(dialog).getByRole('button', { name: 'Save changes' }),
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await screen.findByText('INACTIVE')).toBeInTheDocument();
    });
  });

  describe('Errors (24.5 / Phase 17)', () => {
    it('shows "Maintenance plan not found" for a 404 and offers a way back', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      server.use(
        http.get('/maintenance-plans/plan-1', () =>
          HttpResponse.json({ message: 'Not found' }, { status: 404 }),
        ),
      );

      renderPage();

      await screen.findByText('Maintenance plan not found');
      expect(
        screen.getByRole('button', { name: 'Back to maintenance plans' }),
      ).toBeInTheDocument();
    });

    it('shows a retryable error state for a server error loading the plan', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      server.use(
        http.get('/maintenance-plans/plan-1', () =>
          HttpResponse.json({ message: 'Boom' }, { status: 500 }),
        ),
      );

      renderPage();

      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Retry' }),
      ).toBeInTheDocument();
    });
  });
});
