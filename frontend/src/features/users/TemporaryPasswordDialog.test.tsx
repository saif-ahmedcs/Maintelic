import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { TemporaryPasswordDialog } from './TemporaryPasswordDialog';

describe('TemporaryPasswordDialog', () => {
  it('has no axe violations when open (17.1)', async () => {
    const { container } = render(
      <TemporaryPasswordDialog
        open
        onClose={() => {}}
        email="jordan.reyes@plant.example"
        temporaryPassword="Tmp-Password-123"
      />,
    );
    await screen.findByRole('dialog');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the password, the email it belongs to, and the one-time warning', async () => {
    render(
      <TemporaryPasswordDialog
        open
        onClose={() => {}}
        email="jordan.reyes@plant.example"
        temporaryPassword="Tmp-Password-123"
      />,
    );

    expect(await screen.findByText('Tmp-Password-123')).toBeInTheDocument();
    expect(
      screen.getByText(/jordan\.reyes@plant\.example/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('This password will not be shown again.', {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('copies the password to the clipboard and confirms it', async () => {
    const user = userEvent.setup();
    render(
      <TemporaryPasswordDialog
        open
        onClose={() => {}}
        email="jordan.reyes@plant.example"
        temporaryPassword="Tmp-Password-123"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(
      await screen.findByRole('button', { name: 'Copied' }),
    ).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'Tmp-Password-123',
    );
  });

  it('calls onClose when Done is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <TemporaryPasswordDialog
        open
        onClose={onClose}
        email="jordan.reyes@plant.example"
        temporaryPassword="Tmp-Password-123"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
