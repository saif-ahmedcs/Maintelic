import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../../test/msw/server';
import { signIn, signOut } from '../../lib/auth/session';
import WorkOrderDetailPage from './WorkOrderDetailPage';
import type { Asset } from '../assets/api';
import type { WorkOrder } from './api';
import type { SparePart } from '../spare-parts/api';

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

function renderPage(initialEntries: string[] = ['/app/work-orders/wo-1']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/app/work-orders/:id"
            element={<WorkOrderDetailPage />}
          />
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

export function makeWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-1',
    assetId: 'asset-1',
    maintenancePlanId: null,
    status: 'OPEN',
    source: 'MANUAL',
    priority: 'HIGH',
    assignedToUserId: null,
    description: 'Replace worn seal',
    openedAt: '2026-01-01T00:00:00.000Z',
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

function mockWorkOrderEndpoints(workOrder: WorkOrder) {
  server.use(
    http.get(`/work-orders/${workOrder.id}`, () =>
      HttpResponse.json(workOrder),
    ),
    http.get(`/assets/${workOrder.assetId}`, () =>
      HttpResponse.json(makeAsset({ id: workOrder.assetId })),
    ),
  );
}

describe('WorkOrderDetailPage', () => {
  it('has no axe violations when loaded (17.1)', async () => {
    mockSession(['SUPERVISOR']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockWorkOrderEndpoints(makeWorkOrder({}));

    const { container } = renderPage();
    await screen.findByText('Replace worn seal');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations on the cancel-confirm dialog (17.1, Batch 3)', async () => {
    mockSession(['SUPERVISOR']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockWorkOrderEndpoints(makeWorkOrder({ status: 'OPEN' }));

    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText('Replace worn seal');

    await user.click(screen.getByRole('button', { name: 'Cancel work order' }));
    await screen.findByRole('dialog');

    expect(await axe(container)).toHaveNoViolations();
  });

  describe('Block work order (Phase 12.1)', () => {
    it('offers a Block work order action only while IN_PROGRESS', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockWorkOrderEndpoints(makeWorkOrder({ status: 'IN_PROGRESS' }));

      renderPage();
      await screen.findByText('Replace worn seal');

      expect(
        screen.getByRole('button', { name: 'Block work order' }),
      ).toBeInTheDocument();
    });

    it('does not offer Block work order for a status other than IN_PROGRESS', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockWorkOrderEndpoints(makeWorkOrder({ status: 'ASSIGNED' }));

      renderPage();
      await screen.findByText('Replace worn seal');

      expect(
        screen.queryByRole('button', { name: 'Block work order' }),
      ).not.toBeInTheDocument();
    });

    it('requires a reason of at least 3 characters before submitting', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockWorkOrderEndpoints(makeWorkOrder({ status: 'IN_PROGRESS' }));

      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Replace worn seal');

      await user.click(
        screen.getByRole('button', { name: 'Block work order' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Reason'), 'ab');
      await user.click(
        within(dialog).getByRole('button', { name: 'Block work order' }),
      );

      expect(
        await within(dialog).findByText('Reason must be at least 3 characters'),
      ).toBeInTheDocument();
      // The dialog stays open and no request is sent for an invalid reason.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('blocks the work order with the given reason and closes the dialog', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const workOrder = makeWorkOrder({ status: 'IN_PROGRESS' });
      mockWorkOrderEndpoints(workOrder);

      // The GET handler reflects whatever the PATCH handler last set, so the
      // refetch triggered after a successful block shows the new status.
      let currentWorkOrder = workOrder;
      let receivedBody: unknown;
      server.use(
        http.get(`/work-orders/${workOrder.id}`, () =>
          HttpResponse.json(currentWorkOrder),
        ),
        http.patch(
          `/work-orders/${workOrder.id}/block`,
          async ({ request }) => {
            receivedBody = await request.json();
            currentWorkOrder = {
              ...currentWorkOrder,
              status: 'BLOCKED',
              blockReason: 'Waiting on a replacement part',
            };
            return HttpResponse.json(currentWorkOrder);
          },
        ),
      );

      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Replace worn seal');

      await user.click(
        screen.getByRole('button', { name: 'Block work order' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.type(
        within(dialog).getByLabelText('Reason'),
        'Waiting on a replacement part',
      );
      await user.click(
        within(dialog).getByRole('button', { name: 'Block work order' }),
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(receivedBody).toEqual({ reason: 'Waiting on a replacement part' });
      expect(await screen.findByText('BLOCKED')).toBeInTheDocument();
    });

    it('shows the server error and closes the dialog on a conflicting transition', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      const workOrder = makeWorkOrder({ status: 'IN_PROGRESS' });
      mockWorkOrderEndpoints(workOrder);

      server.use(
        http.patch(`/work-orders/${workOrder.id}/block`, () =>
          HttpResponse.json(
            {
              message: 'Cannot transition work order from BLOCKED to BLOCKED',
              path: `/work-orders/${workOrder.id}/block`,
            },
            { status: 409 },
          ),
        ),
      );

      const user = userEvent.setup();
      renderPage();
      await screen.findByText('Replace worn seal');

      await user.click(
        screen.getByRole('button', { name: 'Block work order' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.type(
        within(dialog).getByLabelText('Reason'),
        'Waiting on a replacement part',
      );
      await user.click(
        within(dialog).getByRole('button', { name: 'Block work order' }),
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(
        await screen.findByText(
          'Cannot transition work order from BLOCKED to BLOCKED',
        ),
      ).toBeInTheDocument();
    });

    it('has no axe violations on the block-reason dialog (17.1)', async () => {
      mockSession(['SUPERVISOR']);
      await signIn({ accessToken: 'token', refreshToken: 'refresh' });
      mockWorkOrderEndpoints(makeWorkOrder({ status: 'IN_PROGRESS' }));

      const user = userEvent.setup();
      const { container } = renderPage();
      await screen.findByText('Replace worn seal');

      await user.click(
        screen.getByRole('button', { name: 'Block work order' }),
      );
      await screen.findByRole('dialog');

      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

function makePart(overrides: Partial<SparePart> = {}): SparePart {
  return {
    id: 'part-1',
    sku: 'BRG-6205',
    name: 'Bearing 6205',
    quantityOnHand: 5,
    reorderThreshold: 2,
    unitCost: 12.5,
    isLowStock: false,
    isOutOfStock: false,
    ...overrides,
  };
}

function mockSparePartsList(parts: SparePart[]) {
  server.use(
    http.get('/spare-parts', () =>
      HttpResponse.json({
        data: parts,
        meta: { page: 1, limit: 100, total: parts.length, totalPages: 1 },
      }),
    ),
  );
}

describe('Complete work order with parts (BL-02)', () => {
  async function openCompleteDialog(workOrder: WorkOrder) {
    mockSession(['SUPERVISOR']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockWorkOrderEndpoints(workOrder);
    const user = userEvent.setup();
    const view = renderPage();
    await screen.findByText('Replace worn seal');
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    const dialog = await screen.findByRole('dialog');
    return { user, dialog, ...view };
  }

  it('opens a parts dialog instead of completing immediately', async () => {
    mockSparePartsList([makePart()]);
    let called = false;
    server.use(
      http.patch('/work-orders/wo-1/complete', () => {
        called = true;
        return HttpResponse.json(makeWorkOrder());
      }),
    );
    const { dialog } = await openCompleteDialog(
      makeWorkOrder({ status: 'IN_PROGRESS' }),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Add part' }),
    ).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('sends the selected parts and quantities', async () => {
    mockSparePartsList([makePart()]);
    let body: unknown;
    server.use(
      http.patch('/work-orders/wo-1/complete', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          makeWorkOrder({
            status: 'COMPLETED',
            totalCost: 25,
            parts: [
              {
                sparePartId: 'part-1',
                quantityUsed: 2,
                unitCostAtCompletion: 12.5,
              },
            ],
          }),
        );
      }),
    );
    const { user, dialog } = await openCompleteDialog(
      makeWorkOrder({ status: 'IN_PROGRESS' }),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Add part' }));
    await user.click(within(dialog).getByLabelText('Part 1'));
    await user.click(
      await within(dialog).findByRole('option', { name: /BRG-6205/ }),
    );
    const qty = within(dialog).getByLabelText('Quantity used 1');
    await user.clear(qty);
    await user.type(qty, '2');
    await user.click(
      within(dialog).getByRole('button', { name: 'Complete work order' }),
    );

    await waitFor(() =>
      expect(body).toEqual({
        parts: [{ sparePartId: 'part-1', quantityUsed: 2 }],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('completes with no parts when none are added', async () => {
    mockSparePartsList([makePart()]);
    let body: unknown;
    server.use(
      http.patch('/work-orders/wo-1/complete', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(makeWorkOrder({ status: 'COMPLETED' }));
      }),
    );
    const { user, dialog } = await openCompleteDialog(
      makeWorkOrder({ status: 'IN_PROGRESS' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Complete work order' }),
    );
    await waitFor(() => expect(body).toEqual({}));
  });

  it('validates part and quantity before sending', async () => {
    mockSparePartsList([makePart()]);
    const { user, dialog } = await openCompleteDialog(
      makeWorkOrder({ status: 'IN_PROGRESS' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add part' }));
    await user.click(
      within(dialog).getByRole('button', { name: 'Complete work order' }),
    );
    expect(
      await within(dialog).findByText('Select a part'),
    ).toBeInTheDocument();
  });

  it('shows the backend insufficient-stock message and keeps the dialog open', async () => {
    mockSparePartsList([makePart()]);
    const message =
      'Insufficient stock for spare part BRG-6205: requested 9, available 5';
    server.use(
      http.patch('/work-orders/wo-1/complete', () =>
        HttpResponse.json({ message }, { status: 409 }),
      ),
    );
    const { user, dialog } = await openCompleteDialog(
      makeWorkOrder({ status: 'IN_PROGRESS' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add part' }));
    await user.click(within(dialog).getByLabelText('Part 1'));
    await user.click(
      await within(dialog).findByRole('option', { name: /BRG-6205/ }),
    );
    const qty = within(dialog).getByLabelText('Quantity used 1');
    await user.clear(qty);
    await user.type(qty, '9');
    await user.click(
      within(dialog).getByRole('button', { name: 'Complete work order' }),
    );

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows total cost for a completed work order', async () => {
    mockSession(['SUPERVISOR']);
    await signIn({ accessToken: 'token', refreshToken: 'refresh' });
    mockWorkOrderEndpoints(
      makeWorkOrder({
        status: 'COMPLETED',
        totalCost: 25,
        parts: [
          {
            sparePartId: 'part-1',
            quantityUsed: 2,
            unitCostAtCompletion: 12.5,
          },
        ],
      }),
    );
    server.use(
      http.get('/spare-parts/part-1', () => HttpResponse.json(makePart())),
    );
    renderPage();
    expect(await screen.findByText('Total cost: 25.00')).toBeInTheDocument();
  });
});
