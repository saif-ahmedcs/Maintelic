import { act, render, screen } from '@testing-library/react';
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
