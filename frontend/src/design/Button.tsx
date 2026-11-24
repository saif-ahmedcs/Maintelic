import type { ComponentPropsWithoutRef } from 'react';
import { IconLoader2 } from '@tabler/icons-react';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'ghost' | 'signal';
export type ButtonSize = 'md' | 'lg';

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
}

export type ButtonProps = ButtonOwnProps &
  Omit<ComponentPropsWithoutRef<'button'>, keyof ButtonOwnProps>;

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn ui-btn-solid bg-gradient-bioluminescent text-text-ink',
  ghost: [
    'ui-btn ui-btn-outline',
    'border border-surface-slate text-text-silver',
    'enabled:hover:text-text-platinum',
  ].join(' '),
  signal: [
    'ui-btn ui-btn-solid ui-btn-signal',
    'font-semibold tracking-[0.12em] text-text-ink',
    'bg-gradient-bioluminescent',
  ].join(' '),
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: 'py-8 px-[22px]', // 32px vertical, 22px horizontal
  lg: 'py-4 px-6', // 16px vertical, 24px horizontal
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  const classes = [
    'inline-flex',
    'items-center',
    'justify-center',
    'gap-2',
    'rounded-small',
    'font-ui',
    'text-ui',
    'uppercase',
    'disabled:opacity-50',
    'disabled:cursor-not-allowed',
    'aria-busy:text-transparent',
    'aria-busy:opacity-[0.85]',
    'aria-busy:cursor-progress',
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={classes}
      {...rest}
    >
      {loading && (
        <Icon icon={IconLoader2} size={16} className="ui-btn-spinner" />
      )}
      {children}
    </button>
  );
}
