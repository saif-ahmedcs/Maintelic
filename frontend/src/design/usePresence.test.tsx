import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from './usePresence';

describe('usePresence', () => {
  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error restore the jsdom default (no Web Animations API)
    delete Element.prototype.getAnimations;
  });

  it('is mounted exactly while open when animation is unavailable (jsdom)', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    });
    expect(result.current).toEqual({ mounted: true, state: 'open' });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: false, state: 'closed' });
  });

  it('stays mounted for the exit duration, then unmounts, when animation is available', () => {
    vi.useFakeTimers();
    Element.prototype.getAnimations = () => [];
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, state: 'closed' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.mounted).toBe(false);
  });

  it('cancels the exit when reopened mid-animation', () => {
    vi.useFakeTimers();
    Element.prototype.getAnimations = () => [];
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    rerender({ open: true });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toEqual({ mounted: true, state: 'open' });
  });
});
