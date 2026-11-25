import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusTag, type StatusTagValue } from './StatusTag';

const ALL_STATUSES: StatusTagValue[] = [
  'OPERATIONAL',
  'UNDER_MAINTENANCE',
  'CRITICAL',
  'DECOMMISSIONED',
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETED',
  'CANCELLED',
  'AUTO',
  'CRITICAL_ASSET',
  'OVERDUE_MAINTENANCE',
  'LOW_STOCK',
  'UNREAD',
  'ACKNOWLEDGED',
  'RESOLVED',
  'ADMIN',
  'SUPERVISOR',
  'TECHNICIAN',
  'VIEWER',
  'ACTIVE',
  'INACTIVE',
];

describe('StatusTag', () => {
  it.each(ALL_STATUSES)('renders the text label for %s', (status) => {
    const { container } = render(<StatusTag status={status} />);
    expect(
      within(container).getByText(status.replace(/_/g, ' ')),
    ).toBeInTheDocument();
  });

  it('replaces underscores with spaces in multi-word labels', () => {
    const { container } = render(<StatusTag status="UNDER_MAINTENANCE" />);
    expect(
      within(container).getByText('UNDER MAINTENANCE'),
    ).toBeInTheDocument();
  });

  it('shows a decorative dot by default', () => {
    const { container } = render(<StatusTag status="OPERATIONAL" />);
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveClass('status-marker');
  });

  it('hides the dot when showDot is false', () => {
    const { container } = render(
      <StatusTag status="OPERATIONAL" showDot={false} />,
    );
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('always renders the same tag shape — uppercase, 6px radius, bordered', () => {
    const { container } = render(<StatusTag status="OPEN" />);
    const el = within(container).getByText('OPEN').closest('span');
    expect(el?.className).toContain('rounded-small');
    expect(el?.className).toContain('uppercase');
    expect(el?.className).toContain('border-surface-slate');
    expect(el?.className).toContain('bg-surface-abyss');
    expect(el?.className).toContain('text-caption');
  });

  it.each<[StatusTagValue, string]>([
    ['OPERATIONAL', 'text-text-mist'],
    ['OPEN', 'text-text-mist'],
    ['COMPLETED', 'text-text-mist'],
    ['RESOLVED', 'text-text-mist'],
    ['UNDER_MAINTENANCE', 'text-text-silver'],
    ['ASSIGNED', 'text-text-silver'],
    ['IN_PROGRESS', 'text-text-silver'],
    ['ACKNOWLEDGED', 'text-text-silver'],
    ['BLOCKED', 'text-text-platinum'],
    ['UNREAD', 'text-text-platinum'],
    ['CRITICAL', 'text-alarm-critical'],
    ['CRITICAL_ASSET', 'text-alarm-critical'],
    ['OVERDUE_MAINTENANCE', 'text-alarm-warning'],
    ['LOW_STOCK', 'text-alarm-warning'],
    ['AUTO', 'text-accent-lavender'],
    ['DECOMMISSIONED', 'text-text-silver'],
    ['CANCELLED', 'text-text-silver'],
    ['ACTIVE', 'text-text-mist'],
    ['INACTIVE', 'text-text-silver'],
  ])('applies the %s text color %s', (status, expectedClass) => {
    const { container } = render(<StatusTag status={status} />);
    const el = within(container)
      .getByText(status.replace(/_/g, ' '))
      .closest('span');
    expect(el?.className).toContain(expectedClass);
  });

  it('marks DECOMMISSIONED, CANCELLED and INACTIVE with an unlit Slate Deep marker, not their text color', () => {
    for (const status of ['DECOMMISSIONED', 'CANCELLED', 'INACTIVE'] as const) {
      const { container } = render(<StatusTag status={status} />);
      const marker = container.querySelector('[aria-hidden="true"]');
      expect(marker).toHaveAttribute('data-tone', 'slate');
      expect(marker).toHaveAttribute('data-lit', 'false');
    }
  });

  it.each<[StatusTagValue, string]>([
    ['OPERATIONAL', 'mist'],
    ['IN_PROGRESS', 'silver'],
    ['BLOCKED', 'platinum'],
    ['CRITICAL', 'critical'],
    ['OUT', 'critical'],
    ['LOW_STOCK', 'warning'],
    ['OVERDUE_MAINTENANCE', 'warning'],
    ['AUTO', 'lavender'],
  ])('lights the %s marker in the %s tone', (status, tone) => {
    const { container } = render(<StatusTag status={status} />);
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).toHaveAttribute('data-tone', tone);
    expect(marker).toHaveAttribute('data-lit', 'true');
  });

  it('role tags (ADMIN, SUPERVISOR, TECHNICIAN, VIEWER) use the neutral silver tier', () => {
    for (const role of [
      'ADMIN',
      'SUPERVISOR',
      'TECHNICIAN',
      'VIEWER',
    ] as const) {
      const { container } = render(<StatusTag status={role} />);
      const el = within(container).getByText(role).closest('span');
      expect(el?.className).toContain('text-text-silver');
    }
  });

  it('merges a custom className alongside the generated classes', () => {
    const { container } = render(
      <StatusTag status="OPEN" className="custom-class" />,
    );
    const el = within(container).getByText('OPEN').closest('span');
    expect(el?.className).toContain('custom-class');
    expect(el?.className).toContain('rounded-small');
  });

  it('forwards extra DOM props to the underlying element', () => {
    const { container } = render(
      <StatusTag status="OPEN" data-testid="status-el" />,
    );
    expect(within(container).getByTestId('status-el')).toBeInTheDocument();
  });

  it('sizes to its content so a flex-column or grid parent cannot stretch it', () => {
    const { container } = render(<StatusTag status="LOW_STOCK" />);
    const el = within(container).getByText('LOW STOCK').closest('span');
    expect(el?.className).toContain('w-fit');
    expect(el?.className).toContain('max-w-full');
  });
});
