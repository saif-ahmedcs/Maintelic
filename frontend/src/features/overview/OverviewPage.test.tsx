import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/msw/server';
import OverviewPage from './OverviewPage';

const EMPTY_LIST_LOW_LIMIT = {
  data: [],
  meta: { page: 1, limit: 1, total: 0, totalPages: 0 },
};

const EMPTY_LIST_FIVE_LIMIT = {
  data: [],
  meta: { page: 1, limit: 5, total: 0, totalPages: 0 },
};

/**
 * The overview page fires five independent counter queries plus the work
 * order queue and alert list. These handlers give every sibling query an
 * empty, successful response so a test can focus on the "Readings last
 * hour" tile without the other queries failing (the MSW server is
 * configured with `onUnhandledFrame: 'error'`, so every query needs a
 * handler).
 */
function mockHappySiblingEndpoints() {
  server.use(
    http.get('/work-orders', ({ request }) => {
      const limit = new URL(request.url).searchParams.get('limit');
      return HttpResponse.json(
        limit === '5' ? EMPTY_LIST_FIVE_LIMIT : EMPTY_LIST_LOW_LIMIT,
      );
    }),
    http.get('/assets', () => HttpResponse.json(EMPTY_LIST_LOW_LIMIT)),
    http.get('/maintenance-plans/due', () =>
      HttpResponse.json(EMPTY_LIST_LOW_LIMIT),
    ),
    http.get('/spare-parts', () => HttpResponse.json(EMPTY_LIST_LOW_LIMIT)),
    http.get('/notifications', () => HttpResponse.json(EMPTY_LIST_FIVE_LIMIT)),
  );
}

function mockTelemetrySummary(response: {
  readingCount: number;
  assetCount: number;
  since: string;
}) {
  server.use(http.get('/telemetry/summary', () => HttpResponse.json(response)));
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/app']}>
        <OverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OverviewPage — Readings last hour counter (9.1)', () => {
  it('renders the live reading count from GET /telemetry/summary', async () => {
    mockHappySiblingEndpoints();
    mockTelemetrySummary({
      readingCount: 128,
      assetCount: 4,
      since: '2026-11-09T10:00:00.000Z',
    });

    renderPage();

    const value = await screen.findByText('128');
    expect(value.closest('div')).toHaveTextContent('Readings last hour');
  });

  it('shows a loading skeleton before the response arrives, then the value', async () => {
    mockHappySiblingEndpoints();
    let resolveResponse: (() => void) | undefined;
    server.use(
      http.get('/telemetry/summary', async () => {
        await new Promise<void>((resolve) => {
          resolveResponse = resolve;
        });
        return HttpResponse.json({
          readingCount: 7,
          assetCount: 1,
          since: '2026-11-09T10:00:00.000Z',
        });
      }),
    );

    renderPage();

    expect(
      await screen.findByText('Loading Readings last hour'),
    ).toBeInTheDocument();

    resolveResponse?.();

    const value = await screen.findByText('7');
    expect(value.closest('div')).toHaveTextContent('Readings last hour');
    expect(
      screen.queryByText('Loading Readings last hour'),
    ).not.toBeInTheDocument();
  });

  it('shows an error with a retry control when the request fails, isolated from other tiles', async () => {
    mockHappySiblingEndpoints();
    server.use(
      http.get('/telemetry/summary', () =>
        HttpResponse.json(
          { message: 'Something went wrong', requestId: 'req_1' },
          { status: 500 },
        ),
      ),
    );

    renderPage();

    const alert = await screen.findByRole('alert');
    const tile = alert.parentElement!;
    expect(tile).toHaveTextContent('Readings last hour');
    expect(tile).toHaveTextContent(
      'Something went wrong on our side. Quote request ID req_1 if you contact support.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // Failure isolation: the page itself and the other counters, built
    // from endpoints that succeeded, still render normally.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Open work orders')).toBeInTheDocument();
    expect(screen.getByText('Critical assets')).toBeInTheDocument();
    expect(screen.queryAllByRole('alert')).toHaveLength(1);
  });

  it('retries the request when the Retry button is clicked', async () => {
    mockHappySiblingEndpoints();
    const user = userEvent.setup();
    let callCount = 0;
    server.use(
      http.get('/telemetry/summary', () => {
        callCount += 1;
        if (callCount === 1) {
          return HttpResponse.json(
            { message: 'Something went wrong' },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          readingCount: 55,
          assetCount: 2,
          since: '2026-11-09T10:00:00.000Z',
        });
      }),
    );

    renderPage();

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    await user.click(retryButton);

    const value = await screen.findByText('55');
    expect(value.closest('div')).toHaveTextContent('Readings last hour');
    expect(callCount).toBe(2);
  });

  it('polls every 30 seconds', async () => {
    mockHappySiblingEndpoints();
    let callCount = 0;
    server.use(
      http.get('/telemetry/summary', () => {
        callCount += 1;
        return HttpResponse.json({
          readingCount: callCount === 1 ? 10 : 20,
          assetCount: 1,
          since: '2026-11-09T10:00:00.000Z',
        });
      }),
    );

    // `shouldAdvanceTime` lets the fake clock keep advancing in real
    // wall-clock time, so the MSW-mocked fetch still resolves normally;
    // `advanceTimersByTime` is then used to jump the refetchInterval
    // timer forward 30 seconds without an actual 30-second wait.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage();

      await screen.findByText('10');
      expect(callCount).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      await screen.findByText('20');
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates failure: a failing sibling tile does not break the Readings last hour tile', async () => {
    mockHappySiblingEndpoints();
    server.use(
      http.get('/assets', () =>
        HttpResponse.json({ message: 'Server error' }, { status: 500 }),
      ),
    );
    mockTelemetrySummary({
      readingCount: 9,
      assetCount: 1,
      since: '2026-11-09T10:00:00.000Z',
    });

    renderPage();

    const value = await screen.findByText('9');
    expect(value.closest('div')).toHaveTextContent('Readings last hour');

    const alert = await screen.findByRole('alert');
    expect(alert.parentElement).toHaveTextContent('Critical assets');
  });

  it('links the telemetry card to the Telemetry page', async () => {
    mockHappySiblingEndpoints();
    mockTelemetrySummary({
      readingCount: 3,
      assetCount: 1,
      since: '2026-11-09T10:00:00.000Z',
    });

    renderPage();
    await screen.findByText('3');

    expect(
      screen.getByRole('link', { name: 'Open live telemetry' }),
    ).toHaveAttribute('href', '/telemetry');
    expect(screen.queryByText(/Phase\s+11/)).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    mockHappySiblingEndpoints();
    mockTelemetrySummary({
      readingCount: 3,
      assetCount: 1,
      since: '2026-11-09T10:00:00.000Z',
    });

    const { container } = renderPage();
    await screen.findByText('3');

    expect(await axe(container)).toHaveNoViolations();
  });
});

function notificationFixture(id: string, message: string) {
  return {
    id,
    type: 'CRITICAL_ASSET',
    relatedEntityType: 'asset',
    relatedEntityId: `asset-${id}`,
    message,
    aiNote: null,
    status: 'UNREAD',
    createdAt: '2026-11-24T08:00:00.000Z',
    resolvedAt: null,
    resolvedByUserId: null,
  };
}

function mockUnreadAlerts({
  unread,
  critical,
  criticalFails = false,
}: {
  unread: number;
  critical: number;
  criticalFails?: boolean;
}) {
  server.use(
    http.get('/notifications', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const isCriticalQuery = params.get('type') === 'CRITICAL_ASSET';
      if (isCriticalQuery && criticalFails) {
        return HttpResponse.json({ message: 'Server error' }, { status: 500 });
      }
      const total = isCriticalQuery ? critical : unread;
      const limit = Number(params.get('limit') ?? 5);
      return HttpResponse.json({
        data: Array.from({ length: Math.min(total, limit) }, (_, index) =>
          notificationFixture(`n${index}`, `Asset PUMP-0${index} is CRITICAL`),
        ),
        meta: {
          page: 1,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    }),
  );
}

function renderOverview() {
  mockHappySiblingEndpoints();
  mockTelemetrySummary({
    readingCount: 3,
    assetCount: 1,
    since: '2026-11-09T10:00:00.000Z',
  });
}

describe('OverviewPage — alerts panel', () => {
  it('shows the unread count and one link to the Alerts page instead of listing alerts', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 12, critical: 3 });

    renderPage();

    expect(
      await screen.findByText('Critical asset alerts need your attention.'),
    ).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Unread alerts')).toBeInTheDocument();

    const links = screen.getAllByRole('link', { name: 'View all alerts' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/alerts');

    // The individual alerts are not rendered on the overview.
    expect(screen.queryByText(/Asset PUMP-0\d is CRITICAL/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('splits the unread count into critical and warning from the real totals', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 12, critical: 3 });

    renderPage();

    const breakdown = await screen.findByRole('list', {
      name: 'Unread alerts by severity',
    });
    const rows = within(breakdown).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Critical');
    expect(rows[0]).toHaveTextContent('3');
    expect(rows[1]).toHaveTextContent('Warning');
    expect(rows[1]).toHaveTextContent('9');
  });

  it('omits a severity row that has nothing in it', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 4, critical: 0 });

    renderPage();

    const breakdown = await screen.findByRole('list', {
      name: 'Unread alerts by severity',
    });
    expect(within(breakdown).getAllByRole('listitem')).toHaveLength(1);
    expect(breakdown).toHaveTextContent('Warning');
    expect(breakdown).not.toHaveTextContent('Critical');
  });

  it('still shows the count when the severity request fails', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 5, critical: 2, criticalFails: true });

    renderPage();

    expect(
      await screen.findByText('Unread alerts are waiting for review.'),
    ).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /severity/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'View all alerts' }),
    ).toHaveAttribute('href', '/alerts');
  });

  it('uses calmer wording when only warning-tier alerts are unread', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 1, critical: 0 });

    renderPage();

    expect(
      await screen.findByText('Unread alerts are waiting for review.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Critical asset alerts need your attention.'),
    ).toBeNull();
  });

  it('shows a calm state with no severity breakdown, and still links, when nothing is unread', async () => {
    renderOverview();

    const { container } = renderPage();

    expect(
      await screen.findByText('No unread alerts right now.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /severity/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'View all alerts' }),
    ).toHaveAttribute('href', '/alerts');
    // The bell is toned down when there is nothing to act on.
    expect(container.querySelector('img[src*="alerts-bell"]')).toHaveClass(
      'opacity-60',
    );
  });

  it('keeps the bell inside the alerts card, at full strength while alerts are unread', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 2, critical: 1 });

    const { container } = renderPage();
    const link = await screen.findByRole('link', { name: 'View all alerts' });

    const bell = container.querySelector('img[src*="alerts-bell"]');
    expect(bell).toBeInTheDocument();
    expect(bell).toHaveAttribute('alt', '');
    expect(bell).not.toHaveClass('opacity-60');
    expect(bell?.closest('.rounded-card')).toContainElement(link);
  });

  it('places the alerts card beside the work order queue in one shared grid', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 2, critical: 1 });

    renderPage();
    const link = await screen.findByRole('link', { name: 'View all alerts' });

    const alertsCard = link.closest('.rounded-card') as HTMLElement;
    const queueCard = screen
      .getByText('Work order queue')
      .closest('.rounded-card') as HTMLElement;
    const telemetryLink = screen.getByRole('link', {
      name: 'Open live telemetry',
    });
    const telemetryCard = telemetryLink.closest('.rounded-card') as HTMLElement;

    // Queue and alerts are siblings in the same grid; the queue takes two
    // of three columns.
    expect(alertsCard.parentElement?.parentElement).toBe(
      queueCard.parentElement,
    );
    expect(queueCard).toHaveClass('xl:col-span-2');
    // Telemetry sits above that grid, outside it.
    expect(queueCard.parentElement).not.toContainElement(telemetryCard);
  });

  it('shows an error with a retry control when the alerts request fails, isolated from other tiles', async () => {
    renderOverview();
    server.use(
      http.get('/notifications', () =>
        HttpResponse.json({ message: 'Server error' }, { status: 500 }),
      ),
    );

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View all alerts' })).toBeNull();
    expect(screen.getByText('Open work orders')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
  });

  it('has no axe violations with unread alerts', async () => {
    renderOverview();
    mockUnreadAlerts({ unread: 12, critical: 3 });

    const { container } = renderPage();
    await screen.findByRole('list', { name: 'Unread alerts by severity' });

    expect(await axe(container)).toHaveNoViolations();
  });
});

function workOrderFixture(index: number) {
  return {
    id: `wo-${index}`,
    assetId: 'asset-1',
    maintenancePlanId: null,
    status: 'OPEN',
    source: 'MANUAL',
    priority: 'MEDIUM',
    assignedToUserId: null,
    description: `Inspect pump ${index}`,
    openedAt: '2026-11-20T10:00:00.000Z',
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    totalCost: null,
    aiNote: null,
    blockReason: null,
    parts: [],
  };
}

function mockQueue(total: number, shown: number) {
  mockHappySiblingEndpoints();
  mockTelemetrySummary({
    readingCount: 0,
    assetCount: 0,
    since: '2026-11-09T10:00:00.000Z',
  });
  server.use(
    http.get('/work-orders', ({ request }) => {
      const limit = new URL(request.url).searchParams.get('limit');
      const rows =
        limit === '5'
          ? Array.from({ length: shown }, (_, i) => workOrderFixture(i + 1))
          : [];
      return HttpResponse.json({
        data: rows,
        meta: {
          page: 1,
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
        },
      });
    }),
    http.get('/assets/:id', () =>
      HttpResponse.json({
        id: 'asset-1',
        assetTypeId: 'type-1',
        locationId: 'loc-1',
        tag: 'PUMP-01',
        manufacturer: null,
        model: null,
        criticality: 'MEDIUM',
        status: 'OPERATIONAL',
        installedAt: null,
      }),
    ),
  );
}

describe('OverviewPage — work order queue footer link', () => {
  it('shows the total and links to the open-status filter when more exist than are listed', async () => {
    mockQueue(12, 5);
    renderPage();

    const link = await screen.findByRole('link', {
      name: 'View all 12 open work orders',
    });
    expect(link).toHaveAttribute('href', '/work-orders?status=OPEN');
    expect(screen.getAllByText(/^Inspect pump/)).toHaveLength(5);
  });

  it('uses the plain label when every open work order is already listed', async () => {
    mockQueue(3, 3);
    renderPage();

    const link = await screen.findByRole('link', {
      name: 'View all open work orders',
    });
    expect(link).toHaveAttribute('href', '/work-orders?status=OPEN');
  });

  it('shows no link when the queue is empty', async () => {
    mockQueue(0, 0);
    renderPage();

    await screen.findByText(/No open work orders/);
    expect(
      screen.queryByRole('link', { name: /View all .*open work orders/ }),
    ).toBeNull();
  });
});
