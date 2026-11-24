import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from './Tabs';

const ITEMS = [
  { value: 'all', label: 'All' },
  { value: 'due', label: 'Due' },
  { value: 'overdue', label: 'Overdue' },
];

describe('Tabs', () => {
  it('marks only the selected tab as selected and focusable', () => {
    render(<Tabs items={ITEMS} value="due" onChange={() => undefined} />);
    expect(screen.getByRole('tab', { name: 'Due' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('calls onChange on click', async () => {
    const onChange = vi.fn();
    render(<Tabs items={ITEMS} value="all" onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Overdue' }));
    expect(onChange).toHaveBeenCalledWith('overdue');
  });

  it('moves with the arrow keys and wraps', async () => {
    const onChange = vi.fn();
    render(<Tabs items={ITEMS} value="all" onChange={onChange} />);
    screen.getByRole('tab', { name: 'All' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('overdue');
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('all');
  });

  it('draws the sliding indicator as a decorative element outside the tab list semantics', () => {
    const { container } = render(
      <Tabs items={ITEMS} value="all" onChange={() => undefined} />,
    );
    const indicator = container.querySelector('.ui-tab-indicator');
    expect(indicator).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Tabs items={ITEMS} value="all" onChange={() => undefined} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
