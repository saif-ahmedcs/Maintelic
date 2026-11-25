import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Heading } from './Heading';

describe('Heading', () => {
  it('defaults to an h2 at the 36px heading scale, medium weight, platinum', () => {
    const { container } = render(<Heading>Overview</Heading>);
    const el = within(container).getByText('Overview');
    expect(el.tagName).toBe('H2');
    expect(el.className).toContain('text-heading');
    expect(el.className).toContain('font-medium');
    expect(el.className).toContain('text-text-platinum');
  });

  it('renders an h1 when level=1', () => {
    const { container } = render(
      <Heading level={1} scale="display">
        Industrial Maintenance Platform
      </Heading>,
    );
    expect(
      within(container).getByRole('heading', { level: 1 }),
    ).toHaveTextContent('Industrial Maintenance Platform');
  });

  it('renders an h3 when level=3', () => {
    const { container } = render(<Heading level={3}>Spare Parts</Heading>);
    expect(within(container).getByText('Spare Parts').tagName).toBe('H3');
  });

  it('applies the heading-lg scale independently of the semantic level', () => {
    const { container } = render(
      <Heading level={2} scale="heading-lg">
        Nothing is overdue
      </Heading>,
    );
    const el = within(container).getByText('Nothing is overdue');
    expect(el.tagName).toBe('H2');
    expect(el.className).toContain('text-heading-lg');
  });

  it('applies the display scale', () => {
    const { container } = render(
      <Heading level={1} scale="display">
        Sign in
      </Heading>,
    );
    expect(within(container).getByRole('heading').className).toContain(
      'text-display',
    );
  });

  it('merges a custom className alongside the generated classes', () => {
    const { container } = render(
      <Heading className="custom-class">Assets</Heading>,
    );
    const el = within(container).getByText('Assets');
    expect(el.className).toContain('custom-class');
    expect(el.className).toContain('text-heading');
  });

  it('gives page titles (level 1) the shared title gradient by default', () => {
    const { container } = render(<Heading level={1}>Assets</Heading>);
    const heading = within(container).getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Assets');
    expect(within(container).getByText('Assets')).toHaveClass('title-gradient');
  });

  it('keeps level 2 and 3 headings platinum with no gradient', () => {
    const { container } = render(
      <>
        <Heading level={2}>Section</Heading>
        <Heading level={3}>Subsection</Heading>
      </>,
    );
    expect(container.querySelector('.title-gradient')).toBeNull();
  });

  it('lets a caller override the tone either way', () => {
    const { container } = render(
      <>
        <Heading level={1} tone="platinum">
          Plain
        </Heading>
        <Heading level={2} tone="gradient">
          Lit
        </Heading>
      </>,
    );
    expect(within(container).getByText('Plain')).not.toHaveClass(
      'title-gradient',
    );
    expect(within(container).getByText('Lit')).toHaveClass('title-gradient');
  });
});
