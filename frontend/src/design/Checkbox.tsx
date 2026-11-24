import type { ComponentPropsWithoutRef } from 'react';

interface CheckboxOwnProps {
  label: string;
  className?: string;
}

export type CheckboxProps = CheckboxOwnProps &
  Omit<ComponentPropsWithoutRef<'input'>, keyof CheckboxOwnProps | 'type'>;

/**
 * A native checkbox (so keyboard, forms and assistive tech behave as
 * usual), drawn with the design system's box and an animated check. The
 * label is part of the hit area.
 */
export function Checkbox({
  label,
  className,
  disabled,
  ...rest
}: CheckboxProps) {
  const labelClasses = [
    'group',
    'flex',
    'w-fit',
    'items-center',
    'gap-2',
    'font-ui',
    'text-ui',
    'text-text-platinum',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label className={labelClasses}>
      <input
        {...rest}
        type="checkbox"
        disabled={disabled}
        className="ui-checkbox"
      />
      {label}
    </label>
  );
}
