import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './Checkbox';

function Controlled({ disabled = false }: { disabled?: boolean }) {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      label="SUPERVISOR"
      checked={checked}
      onChange={() => setChecked((value) => !value)}
      disabled={disabled}
    />
  );
}

describe('Checkbox', () => {
  it('is a native checkbox named by its label', () => {
    render(<Controlled />);
    expect(screen.getByRole('checkbox', { name: 'SUPERVISOR' })).toBeVisible();
  });

  it('toggles from a click on the label text', async () => {
    render(<Controlled />);
    await userEvent.click(screen.getByText('SUPERVISOR'));
    expect(screen.getByRole('checkbox', { name: 'SUPERVISOR' })).toBeChecked();
  });

  it('toggles from the keyboard', async () => {
    render(<Controlled />);
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'SUPERVISOR' })).toBeChecked();
  });

  it('does not toggle when disabled', async () => {
    render(<Controlled disabled />);
    await userEvent.click(screen.getByText('SUPERVISOR'));
    expect(
      screen.getByRole('checkbox', { name: 'SUPERVISOR' }),
    ).not.toBeChecked();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Controlled />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
