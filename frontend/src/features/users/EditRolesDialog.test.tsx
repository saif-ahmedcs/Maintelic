import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/msw/server';
import { EditRolesDialog } from './EditRolesDialog';
import type { User } from './api';

const ADMIN_USER: User = {
  id: 'user-1',
  email: 'admin@plant.example',
  name: 'Last Admin',
  isActive: true,
  roles: ['ADMIN'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderDialog(user: User | null, onClose: () => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <EditRolesDialog open onClose={onClose} user={user} />
    </QueryClientProvider>,
  );
}

describe('EditRolesDialog', () => {
  it('has no axe violations when open (17.1)', async () => {
    const { container } = renderDialog(ADMIN_USER);
    await screen.findByRole('dialog');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('pre-fills the checkboxes from the user’s current roles', async () => {
    renderDialog(ADMIN_USER);
    await screen.findByRole('dialog');

    expect(screen.getByRole('checkbox', { name: 'ADMIN' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'SUPERVISOR' }),
    ).not.toBeChecked();
  });

  it('saves the new role set and closes on success', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    server.use(
      http.put('/users/user-1/roles', () =>
        HttpResponse.json({ ...ADMIN_USER, roles: ['ADMIN', 'SUPERVISOR'] }),
      ),
    );

    renderDialog(ADMIN_USER, onClose);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('checkbox', { name: 'SUPERVISOR' }));
    await user.click(screen.getByRole('button', { name: 'Save roles' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows the server’s 409 message and keeps the dialog open when the last admin would be removed (Phase 21.7)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const adminAndSupervisor: User = {
      ...ADMIN_USER,
      roles: ['ADMIN', 'SUPERVISOR'],
    };

    server.use(
      http.put('/users/user-1/roles', () =>
        HttpResponse.json(
          { message: 'At least one active admin is required.' },
          { status: 409 },
        ),
      ),
    );

    renderDialog(adminAndSupervisor, onClose);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('checkbox', { name: 'ADMIN' }));
    await user.click(screen.getByRole('button', { name: 'Save roles' }));

    expect(
      await screen.findByText('At least one active admin is required.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
