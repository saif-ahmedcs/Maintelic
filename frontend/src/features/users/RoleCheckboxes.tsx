import type { Role } from '../auth/api';

export interface RoleCheckboxesProps {
  legend: string;
  selected: Role[];
  onChange: (roles: Role[]) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
}

const ALL_ROLES: Role[] = ['ADMIN', 'SUPERVISOR', 'TECHNICIAN', 'VIEWER'];

const LEGEND_CLASSES = [
  'font-display',
  'uppercase',
  'text-label',
  'font-normal',
  'text-text-silver',
].join(' ');

export function RoleCheckboxes({
  legend,
  selected,
  onChange,
  error,
  hint,
  disabled = false,
}: RoleCheckboxesProps) {
  function toggle(role: Role) {
    if (selected.includes(role)) {
      onChange(selected.filter((current) => current !== role));
    } else {
      onChange([...selected, role]);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={LEGEND_CLASSES}>{legend}</legend>
      <div className="flex flex-col gap-2">
        {ALL_ROLES.map((role) => (
          <label
            key={role}
            className="flex items-center gap-2 font-ui text-ui text-text-platinum"
          >
            <input
              type="checkbox"
              checked={selected.includes(role)}
              onChange={() => toggle(role)}
              disabled={disabled}
              className="size-4 accent-accent-teal-signal"
            />
            {role}
          </label>
        ))}
      </div>
      {error ? (
        <p role="alert" className="font-ui text-ui text-accent-lavender">
          {error}
        </p>
      ) : (
        hint && <p className="font-ui text-ui text-text-silver">{hint}</p>
      )}
    </fieldset>
  );
}
