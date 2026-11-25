import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusMarker, type StatusMarkerTone } from './StatusMarker';

const TONES: StatusMarkerTone[] = [
  'mist',
  'silver',
  'platinum',
  'critical',
  'warning',
  'lavender',
  'slate',
];

describe('StatusMarker', () => {
  it.each(TONES)('renders a decorative %s marker', (tone) => {
    const { container } = render(<StatusMarker tone={tone} />);
    const el = container.firstElementChild;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveAttribute('data-tone', tone);
    expect(el).toHaveClass('status-marker');
    expect(el?.textContent).toBe('');
  });

  it('is lit by default and unlit when lit is false', () => {
    const { container, rerender } = render(<StatusMarker tone="mist" />);
    expect(container.firstElementChild).toHaveAttribute('data-lit', 'true');
    rerender(<StatusMarker tone="mist" lit={false} />);
    expect(container.firstElementChild).toHaveAttribute('data-lit', 'false');
  });

  it('merges className and forwards DOM props', () => {
    const { container } = render(
      <StatusMarker tone="critical" className="extra" data-testid="m" />,
    );
    expect(container.firstElementChild).toHaveClass('status-marker', 'extra');
    expect(container.firstElementChild).toHaveAttribute('data-testid', 'm');
  });
});
