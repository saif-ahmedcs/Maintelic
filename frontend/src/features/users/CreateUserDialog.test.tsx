import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/msw/server';
import { CreateUserDialog } from './CreateUserDialog';
import type { TemporaryPasswordResult } from './api';

function renderDialog(onCreated: (result: TemporaryPasswordResult) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateUserDialog open onClose={() => {}} onCreated={onCreated} />
    </QueryClientProvider>,
  );
}

describe('CreateUserDialog', () => {
  it('has no axe violations when open (17.1)', async () => {
    const { container } = renderDialog(() => {});
    await screen.findByRole('dialog');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('requires at least one role before submitting', async () => {
    const user = userEvent.setup();
    renderDialog(() => {});

    const dialog = await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Name'), 'Jordan Reyes');
    await user.type(
      screen.getByLabelText('Email'),
      'jordan.reyes@plant.example',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add user' }));

    expect(
      await screen.findByText('Select at least one role'),
    ).toBeInTheDocument();
  });

  it('creates a user and hands the temporary password to the caller', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();

    server.use(
      http.post('/users', () =>
        HttpResponse.json({
          id: 'user-new',
          email: 'jordan.reyes@plant.example',
          name: 'Jordan Reyes',
          isActive: true,
          roles: ['SUPERVISOR'],
          createdAt: '2026-01-01T00:00:00.000Z',
          temporaryPassword: 'Tmp-Password-123',
        }),
      ),
    );

    renderDialog(onCreated);

    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Name'), 'Jordan Reyes');
    await user.type(
      screen.getByLabelText('Email'),
      'jordan.reyes@plant.example',
    );
    await user.click(screen.getByRole('checkbox', { name: 'SUPERVISOR' }));
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        temporaryPassword: 'Tmp-Password-123',
        user: expect.objectContaining({ email: 'jordan.reyes@plant.example' }),
      }),
    );
  });

  it('shows the server message for a duplicate email without a field prefix', async () => {
    const user = userEvent.setup();

    server.use(
      http.post('/users', () =>
        HttpResponse.json(
          { message: 'An account with this email already exists' },
          { status: 409 },
        ),
      ),
    );

    renderDialog(() => {});

    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Name'), 'Jordan Reyes');
    await user.type(screen.getByLabelText('Email'), 'existing@plant.example');
    await user.click(screen.getByRole('checkbox', { name: 'VIEWER' }));
    await user.click(screen.getByRole('button', { name: 'Add user' }));

    expect(
      await screen.findByText('An account with this email already exists'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
