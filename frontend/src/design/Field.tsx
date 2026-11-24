import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react';

type FieldableProps = {
  id?: string;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
};

export type FieldVariant = 'default' | 'glass';

export interface FieldProps {
  label: string;
  variant?: FieldVariant;
  startAdornment?: ReactNode;
  endAdornment?: ReactNode;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactElement<FieldableProps>;
}

const INPUT_CLASSES = [
  'w-full',
  'rounded-small',
  'border',
  'border-surface-slate',
  'bg-surface-kelp',
  'px-[14px]',
  'py-3',
  'font-ui',
  'text-ui',
  'text-text-platinum',
  'transition-[border-color,background-color,box-shadow]',
  'duration-(--motion-duration-fast)',
  'ease-standard',
  'hover:border-text-silver/60',
  'focus:border-text-mist',
  'aria-[invalid=true]:border-accent-lavender/60',
].join(' ');

const GLASS_INPUT_CLASSES = [
  'w-full',
  'rounded-small',
  'border',
  'border-text-silver/25',
  'bg-surface-deep/45',
  'px-[14px]',
  'py-3.5',
  'font-ui',
  'text-ui',
  'text-text-platinum',
  'placeholder:text-text-silver/60',
  'transition-[border-color,background-color,box-shadow]',
  'duration-(--motion-duration-fast)',
  'ease-standard',
  'hover:border-text-silver/45',
  'focus:border-accent-aurora-cyan/60',
  'focus:bg-surface-deep/60',
  'focus:outline-none',
  'focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent-aurora-cyan)_12%,transparent)]',
  'aria-[invalid=true]:border-accent-lavender/60',
].join(' ');

export function Field({
  label,
  variant = 'default',
  startAdornment,
  endAdornment,
  error,
  hint,
  className,
  children,
}: FieldProps) {
  const generatedId = useId();
  const hintId = `${generatedId}-hint`;
  const errorId = `${generatedId}-error`;

  const childId =
    (isValidElement(children) && children.props.id) || generatedId;

  const describedBy =
    [hint && !error ? hintId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const field = isValidElement(children)
    ? cloneElement(children, {
        id: childId,
        'aria-describedby':
          [children.props['aria-describedby'], describedBy]
            .filter(Boolean)
            .join(' ') || undefined,
        'aria-invalid': error ? true : children.props['aria-invalid'],
        className: [
          variant === 'glass' ? GLASS_INPUT_CLASSES : INPUT_CLASSES,
          startAdornment ? 'pl-11' : null,
          endAdornment ? 'pr-11' : null,
          children.props.className,
        ]
          .filter(Boolean)
          .join(' '),
      })
    : children;

  const classes = ['flex', 'flex-col', 'gap-1.5', className]
    .filter(Boolean)
    .join(' ');

  const labelClasses = [
    'font-display',
    'uppercase',
    'text-label', // 12px / 1.4 / 0.12em
    variant === 'glass' ? 'font-medium' : 'font-normal',
    'text-text-silver',
  ].join(' ');

  return (
    <div className={classes}>
      <label htmlFor={childId} className={labelClasses}>
        {label}
      </label>
      {startAdornment || endAdornment ? (
        <div className="relative">
          {startAdornment && (
            <span className="pointer-events-none absolute inset-y-0 left-0 flex w-11 items-center justify-center text-text-silver/70">
              {startAdornment}
            </span>
          )}
          {field}
          {endAdornment && (
            <span className="absolute inset-y-0 right-0 flex items-center pr-1.5">
              {endAdornment}
            </span>
          )}
        </div>
      ) : (
        field
      )}
      {/* Error replaces the hint rather than stacking below it. */}
      {error ? (
        <p
          id={errorId}
          className="ui-enter font-ui text-ui text-accent-lavender"
        >
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="font-ui text-ui text-text-silver">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
