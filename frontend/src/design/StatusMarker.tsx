import type { ComponentPropsWithoutRef } from 'react';

export type StatusMarkerTone =
  | 'mist'
  | 'silver'
  | 'platinum'
  | 'critical'
  | 'warning'
  | 'lavender'
  | 'slate';

interface StatusMarkerOwnProps {
  tone: StatusMarkerTone;
  lit?: boolean;
}

export type StatusMarkerProps = StatusMarkerOwnProps &
  Omit<ComponentPropsWithoutRef<'span'>, keyof StatusMarkerOwnProps>;

export function StatusMarker({
  tone,
  lit = true,
  className,
  ...rest
}: StatusMarkerProps) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      data-lit={lit ? 'true' : 'false'}
      className={['status-marker', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
