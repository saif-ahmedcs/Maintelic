import { useEffect, useState } from 'react';

const FALLBACK_EXIT_MS = 180;

function canAnimateExit(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof Element === 'undefined') return false;
  if (typeof Element.prototype.getAnimations !== 'function') return false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return !reduced?.matches;
}

function readExitDuration(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--motion-duration-exit')
    .trim();
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return FALLBACK_EXIT_MS;
  return raw.endsWith('ms') ? value : value * 1000;
}

export interface Presence {
  mounted: boolean;
  state: 'open' | 'closed';
}

export function usePresence(open: boolean): Presence {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  useEffect(() => {
    if (open || !present) return;
    if (!canAnimateExit()) {
      setPresent(false);
      return;
    }
    const timer = window.setTimeout(
      () => setPresent(false),
      readExitDuration(),
    );
    return () => window.clearTimeout(timer);
  }, [open, present]);

  return {
    mounted: open || (present && canAnimateExit()),
    state: open ? 'open' : 'closed',
  };
}
