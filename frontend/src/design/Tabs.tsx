import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export interface TabItem {
  value: string;
  label: string;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function Tabs({ items, value, onChange, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    function place() {
      const selected = list?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      list?.style.setProperty('--tab-x', `${selected?.offsetLeft ?? 0}px`);
      list?.style.setProperty('--tab-w', `${selected?.offsetWidth ?? 0}px`);
    }

    place();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    list.querySelectorAll('[role="tab"]').forEach((tab) => {
      observer.observe(tab);
    });
    return () => observer.disconnect();
  }, [items, value]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      listRef.current?.setAttribute('data-ready', 'true');
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function focusTab(index: number) {
    const id = `tab-${items[index]?.value}`;
    document.getElementById(id)?.focus();
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = (index + 1) % items.length;
      onChange(items[next].value);
      focusTab(next);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prev = (index - 1 + items.length) % items.length;
      onChange(items[prev].value);
      focusTab(prev);
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      className={['ui-tabs flex items-center gap-6', className]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item, index) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            id={`tab-${item.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={[
              'ui-tab',
              'font-display',
              'uppercase',
              'text-label',
              'font-normal',
              'border-b-2',
              'border-transparent',
              'pb-2',
              active
                ? 'text-text-platinum'
                : 'text-text-silver hover:border-text-silver/30 hover:text-text-platinum',
            ].join(' ')}
          >
            {item.label}
          </button>
        );
      })}
      {/* The selected underline. Decorative: selection is already
          exposed through aria-selected. */}
      <span aria-hidden="true" className="ui-tab-indicator" />
    </div>
  );
}
