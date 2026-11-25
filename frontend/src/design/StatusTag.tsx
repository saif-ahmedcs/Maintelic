import type { ComponentPropsWithoutRef } from 'react';
import { StatusMarker, type StatusMarkerTone } from './StatusMarker';

export type StatusTagValue =
  | 'OPERATIONAL'
  | 'UNDER_MAINTENANCE'
  | 'CRITICAL'
  | 'DECOMMISSIONED'
  | 'OPEN'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'AUTO'
  | 'CRITICAL_ASSET'
  | 'OVERDUE_MAINTENANCE'
  | 'LOW_STOCK'
  | 'OUT'
  | 'UNREAD'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'ADMIN'
  | 'SUPERVISOR'
  | 'TECHNICIAN'
  | 'VIEWER'
  | 'ACTIVE'
  | 'INACTIVE';

interface StatusTagOwnProps {
  status: StatusTagValue;
  showDot?: boolean;
  className?: string;
}

export type StatusTagProps = StatusTagOwnProps &
  Omit<ComponentPropsWithoutRef<'span'>, keyof StatusTagOwnProps>;

const STATUS_STYLE: Record<
  StatusTagValue,
  { text: string; marker: StatusMarkerTone }
> = {
  // OPERATIONAL / OPEN / COMPLETED tier — Liquid Mist
  OPERATIONAL: { text: 'text-text-mist', marker: 'mist' },
  OPEN: { text: 'text-text-mist', marker: 'mist' },
  COMPLETED: { text: 'text-text-mist', marker: 'mist' },
  RESOLVED: { text: 'text-text-mist', marker: 'mist' },
  ACTIVE: { text: 'text-text-mist', marker: 'mist' },

  // UNDER_MAINTENANCE / ASSIGNED / IN_PROGRESS tier — Silver Mist
  UNDER_MAINTENANCE: { text: 'text-text-silver', marker: 'silver' },
  ASSIGNED: { text: 'text-text-silver', marker: 'silver' },
  IN_PROGRESS: { text: 'text-text-silver', marker: 'silver' },
  ACKNOWLEDGED: { text: 'text-text-silver', marker: 'silver' },
  ADMIN: { text: 'text-text-silver', marker: 'silver' },
  SUPERVISOR: { text: 'text-text-silver', marker: 'silver' },
  TECHNICIAN: { text: 'text-text-silver', marker: 'silver' },
  VIEWER: { text: 'text-text-silver', marker: 'silver' },

  // BLOCKED tier — Platinum
  BLOCKED: { text: 'text-text-platinum', marker: 'platinum' },
  UNREAD: { text: 'text-text-platinum', marker: 'platinum' },

  // CRITICAL tier — Alarm Critical
  CRITICAL: { text: 'text-alarm-critical', marker: 'critical' },
  CRITICAL_ASSET: { text: 'text-alarm-critical', marker: 'critical' },
  // OUT (zero stock) — more severe than LOW_STOCK, same tier as CRITICAL
  OUT: { text: 'text-alarm-critical', marker: 'critical' },

  // WARNING tier — Alarm Warning
  OVERDUE_MAINTENANCE: { text: 'text-alarm-warning', marker: 'warning' },
  LOW_STOCK: { text: 'text-alarm-warning', marker: 'warning' },

  // AUTO source tag — Lavender Phosphor
  AUTO: { text: 'text-accent-lavender', marker: 'lavender' },

  // DECOMMISSIONED / CANCELLED / INACTIVE — Silver Mist text, unlit Slate Deep marker
  DECOMMISSIONED: { text: 'text-text-silver', marker: 'slate' },
  CANCELLED: { text: 'text-text-silver', marker: 'slate' },
  INACTIVE: { text: 'text-text-silver', marker: 'slate' },
};

function toLabel(status: StatusTagValue): string {
  return status.replace(/_/g, ' ');
}

export function StatusTag({
  status,
  showDot = true,
  className,
  ...rest
}: StatusTagProps) {
  const style = STATUS_STYLE[status];

  const classes = [
    'inline-flex',
    'items-center',
    'gap-1.5',
    'rounded-small',
    'border',
    'border-surface-slate',
    'bg-surface-abyss',
    'px-[10px]',
    'py-1',
    'font-display',
    'font-normal',
    'uppercase',
    'text-caption',
    'transition-colors',
    'duration-(--motion-duration-fast)',
    'ease-standard',
    style.text,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} {...rest}>
      {showDot && (
        <StatusMarker tone={style.marker} lit={style.marker !== 'slate'} />
      )}
      {toLabel(status)}
    </span>
  );
}
