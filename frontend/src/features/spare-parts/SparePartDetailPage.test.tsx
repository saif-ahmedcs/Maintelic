import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../test/msw/server';
import { signIn, signOut } from '../../lib/auth/session';
import { formatCurrency, formatNumber } from '../../lib/format';
import SparePartDetailPage from './SparePartDetailPage';
import type { InventoryTransaction, SparePart } from './api';

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

function renderPage(initialEntries: string[] = ['/app/spare-parts/sp-1']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/app/spare-parts/:id"
            element={<SparePartDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makePart(overrides: Partial<SparePart> = {}): SparePart {
  return {
    id: 'sp-1',
    sku: 'PUMP-SEAL',
    name: 'Pump mechanical seal',
    quantityOnHand: 55,
    reorderThreshold: 10,
    unitCost: 12.5,
    isLowStock: false,
    isOutOfStock: false,
    ...overrides,
  };
}

function makeTransaction(
  overrides: Partial<InventoryTransaction> = {},
): InventoryTransaction {
  return {
    id: 'txn-1',
    sparePartId: 'sp-1',
    deltaQuantity: 50,
    reason: 'RESTOCK',
    workOrderId: null,
    createdByUserId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    quantityBefore: 5,
    quantityAfter: 55,
    createdAt: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function transactionsPage(
  transactions: InventoryTransaction[],
  meta: Partial<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> = {},
) {
  return {
    data: transactions,
    meta: {
      page: 1,
      limit: 10,
      total: transactions.length,
      totalPages: 1,
      ...meta,
    },
  };
}

// Testing Library's default text matcher collapses whitespace (including
// the non-breaking space Intl.NumberFormat uses between the currency symbol
// and the amount) to a single regular space before comparing, so the
// expected string needs the same normalization applied.
function currencyText(value: number): string {
  return formatCurrency(value).replace(/\s/g, ' ');
}

function mockSparePartEndpoints(
  part: SparePart,
  transactions: InventoryTransaction[] = [],
) {
  server.use(
    http.get(`/spare-parts/${part.id}`, () => HttpResponse.json(part)),
    http.get(`/spare-parts/${part.id}/transactions`, () =>
      HttpResponse.json(transactionsPage(transactions)),
    ),
  );
}

describe('SparePartDetailPage', () => {
  it('renders the header, server-computed stat counters, and transaction history with no axe violations (17.1)', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(makePart({}), [makeTransaction({})]);

    const { container } = renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(screen.getByText('PUMP-SEAL')).toBeInTheDocument();

    // Stat counters come straight from the server response fields, not a
    // client-side recomputation.
    expect(screen.getByText(formatNumber(55))).toBeInTheDocument(); // quantity on hand
    expect(screen.getByText(formatNumber(10))).toBeInTheDocument(); // reorder threshold
    expect(screen.getByText(currencyText(12.5))).toBeInTheDocument(); // unit cost
    expect(screen.getByText(currencyText(687.5))).toBeInTheDocument(); // 55 * 12.5 total value

    const row = await screen.findByRole('row', { name: /\+50/ });
    expect(within(row).getByText('Restock')).toBeInTheDocument();
    expect(within(row).getByText('55')).toBeInTheDocument();
    expect(within(row).getByText('User #AAAAAAAA')).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows OUT when isOutOfStock is true, taking priority over isLowStock', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(
      makePart({ quantityOnHand: 0, isLowStock: true, isOutOfStock: true }),
    );

    renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(screen.getByText('OUT')).toBeInTheDocument();
    expect(screen.queryByText('LOW STOCK')).not.toBeInTheDocument();
  });

  it('shows LOW STOCK exactly when the server marks isLowStock (boundary: quantity === threshold)', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(
      makePart({
        quantityOnHand: 10,
        reorderThreshold: 10,
        isLowStock: true,
        isOutOfStock: false,
      }),
    );

    renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(screen.getByText('LOW STOCK')).toBeInTheDocument();
    expect(screen.queryByText('OUT')).not.toBeInTheDocument();
  });

  it('shows neither tag when the part is above threshold and in stock', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(makePart({}));

    renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(screen.queryByText('LOW STOCK')).not.toBeInTheDocument();
    expect(screen.queryByText('OUT')).not.toBeInTheDocument();
  });

  it('hides restock, adjust, and delete for a VIEWER', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(makePart({}));

    renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(
      screen.queryByRole('button', { name: 'Restock' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Adjust' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete' }),
    ).not.toBeInTheDocument();
  });

  it('offers restock, adjust, and delete for a SUPERVISOR', async () => {
    mockSession(['SUPERVISOR']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(makePart({}));

    renderPage();

    await screen.findByRole('heading', { name: 'Pump mechanical seal' });
    expect(screen.getByRole('button', { name: 'Restock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('shows "No stock movements recorded for this part yet." when there is no history', async () => {
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockSparePartEndpoints(makePart({}), []);

    renderPage();

    await screen.findByText('No stock movements recorded for this part yet.');
  });

  describe('Adjust (Phase 23.4, 23.6)', () => {
    it('refetches the part and the transaction table after a successful adjustment', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });

      const part = makePart({ id: 'sp-adjust', quantityOnHand: 55 });
      let currentPart = part;
      let currentTransactions = [makeTransaction({ id: 'txn-1' })];

      server.use(
        http.get(`/spare-parts/${part.id}`, () =>
          HttpResponse.json(currentPart),
        ),
        http.get(`/spare-parts/${part.id}/transactions`, () =>
          HttpResponse.json(transactionsPage(currentTransactions)),
        ),
        http.post(`/spare-parts/${part.id}/adjust`, async ({ request }) => {
          const body = (await request.json()) as {
            delta: number;
            reason: string;
          };
          currentPart = { ...currentPart, quantityOnHand: 52 };
          const transaction = makeTransaction({
            id: 'txn-2',
            deltaQuantity: body.delta,
            reason: 'ADJUSTMENT',
            quantityBefore: 55,
            quantityAfter: 52,
          });
          currentTransactions = [transaction, ...currentTransactions];
          return HttpResponse.json({
            sparePart: currentPart,
            transaction,
          });
        }),
      );

      renderPage(['/app/spare-parts/sp-adjust']);

      await screen.findByRole('heading', { name: 'Pump mechanical seal' });
      // Scope to the stat tile: the same number also appears in the
      // transaction table's "Quantity after" column once it has loaded.
      const onHandStat = (await screen.findByText('Quantity on hand'))
        .parentElement as HTMLElement;
      expect(
        within(onHandStat).getByText(formatNumber(55)),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Adjust' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Adjust PUMP-SEAL',
      });
      await user.type(within(dialog).getByLabelText('Delta'), '-3');
      await user.type(
        within(dialog).getByLabelText('Reason'),
        'Cycle count correction',
      );
      await user.click(
        within(dialog).getByRole('button', { name: 'Save adjustment' }),
      );

      // Dialog closes and the stat counter reflects the server's new figure,
      // not a client-side subtraction.
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          within(onHandStat).getByText(formatNumber(52)),
        ).toBeInTheDocument(),
      );

      // The transaction table refetched and shows the new row.
      const newRow = await screen.findByRole('row', { name: /-3/ });
      expect(within(newRow).getByText('Adjustment')).toBeInTheDocument();
      expect(within(newRow).getByText('52')).toBeInTheDocument();
    });
  });

  describe('Delete (Phase 23.5)', () => {
    it('asks for confirmation, with no axe violations on the dialog', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockSparePartEndpoints(makePart({}));

      const { container } = renderPage();
      await screen.findByRole('heading', { name: 'Pump mechanical seal' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await screen.findByRole('dialog', { name: 'Delete PUMP-SEAL?' });

      expect(await axe(container)).toHaveNoViolations();
    });

    it('deletes the part on confirmation', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockSparePartEndpoints(makePart({}));

      let deleteCalled = false;
      server.use(
        http.delete('/spare-parts/sp-1', () => {
          deleteCalled = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Pump mechanical seal' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Delete PUMP-SEAL?',
      });
      await user.click(
        within(dialog).getByRole('button', { name: 'Delete part' }),
      );

      await waitFor(() => expect(deleteCalled).toBe(true));
    });

    it('shows the server error and keeps the part when deletion fails', async () => {
      const user = userEvent.setup();
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockSparePartEndpoints(makePart({}));

      server.use(
        http.delete('/spare-parts/sp-1', () =>
          HttpResponse.json(
            { message: 'Cannot delete a part referenced by a work order' },
            { status: 409 },
          ),
        ),
      );

      renderPage();
      await screen.findByRole('heading', { name: 'Pump mechanical seal' });

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Delete PUMP-SEAL?',
      });
      await user.click(
        within(dialog).getByRole('button', { name: 'Delete part' }),
      );

      expect(
        await within(dialog).findByText(
          'Cannot delete a part referenced by a work order',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'Pump mechanical seal' }),
      ).toBeInTheDocument();
    });
  });

  describe('Errors (Phase 17)', () => {
    it('shows "Spare part not found" for a 404 and offers a way back', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      server.use(
        http.get('/spare-parts/sp-1', () =>
          HttpResponse.json({ message: 'Not found' }, { status: 404 }),
        ),
      );

      renderPage();

      await screen.findByText('Spare part not found');
      expect(
        screen.getByRole('button', { name: 'Back to spare parts' }),
      ).toBeInTheDocument();
    });

    it('shows a retryable error state for a server error loading the part', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      server.use(
        http.get('/spare-parts/sp-1', () =>
          HttpResponse.json({ message: 'Boom' }, { status: 500 }),
        ),
      );

      renderPage();

      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Retry' }),
      ).toBeInTheDocument();
    });

    it('shows a retryable error state for the transaction history independent of the loaded part', async () => {
      mockSession(['VIEWER']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      server.use(
        http.get('/spare-parts/sp-1', () => HttpResponse.json(makePart({}))),
        http.get('/spare-parts/sp-1/transactions', () =>
          HttpResponse.json({ message: 'Boom' }, { status: 500 }),
        ),
      );

      renderPage();

      await screen.findByRole('heading', { name: 'Pump mechanical seal' });
      const alert = await screen.findByRole('alert');
      expect(
        within(alert).getByRole('button', { name: 'Retry' }),
      ).toBeInTheDocument();
    });
  });

  it('paginates the transaction history', async () => {
    const user = userEvent.setup();
    mockSession(['VIEWER']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });

    const part = makePart({});
    server.use(
      http.get(`/spare-parts/${part.id}`, () => HttpResponse.json(part)),
      http.get(`/spare-parts/${part.id}/transactions`, ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get('page') ?? '1';
        const transaction =
          page === '2'
            ? makeTransaction({ id: 'txn-page-2', deltaQuantity: 7 })
            : makeTransaction({ id: 'txn-page-1', deltaQuantity: 50 });
        return HttpResponse.json(
          transactionsPage([transaction], {
            page: Number(page),
            totalPages: 2,
            total: 2,
          }),
        );
      }),
    );

    renderPage();

    await screen.findByRole('row', { name: /\+50/ });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('row', { name: /\+7/ });
  });
});
