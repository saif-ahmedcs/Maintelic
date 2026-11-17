import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '../../design/Button';
import { Eyebrow } from '../../design/Eyebrow';
import { Field } from '../../design/Field';
import { Heading } from '../../design/Heading';
import { StatusTag } from '../../design/StatusTag';
import { Surface } from '../../design/Surface';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { refreshSessionUser, useSession } from '../../lib/auth/session';
import { changePassword } from './api';

interface PasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

type FieldErrors = Partial<Record<keyof PasswordFormValues, string>>;

const EMPTY_VALUES: PasswordFormValues = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

const FIELD_ORDER: (keyof PasswordFormValues)[] = [
  'currentPassword',
  'newPassword',
  'confirmPassword',
];

const passwordFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(12, 'New password must be at least 12 characters'),
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: 'New password and confirmation do not match',
    path: ['confirmPassword'],
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

export default function AccountPage() {
  const { user } = useSession();

  const [values, setValues] = useState<PasswordFormValues>(EMPTY_VALUES);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [justChanged, setJustChanged] = useState(false);

  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const fieldRefs = {
    currentPassword: currentPasswordRef,
    newPassword: newPasswordRef,
    confirmPassword: confirmPasswordRef,
  };

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: async () => {
      setValues(EMPTY_VALUES);
      setFieldErrors({});
      setFormError(null);
      setJustChanged(true);
      await refreshSessionUser();
    },
    onError: (error: unknown) => {
      setJustChanged(false);

      if (error instanceof ApiError && error.status === 401) {
        setFieldErrors({ currentPassword: error.message });
        setFormError(null);
        currentPasswordRef.current?.focus();
        return;
      }

      if (error instanceof ApiError) {
        const { field, message } = toUserMessage(error);
        if (field && (field as keyof PasswordFormValues) in EMPTY_VALUES) {
          setFieldErrors({ [field]: message } as FieldErrors);
          setFormError(null);
        } else {
          setFieldErrors({});
          setFormError(message);
        }
        return;
      }

      setFieldErrors({});
      setFormError('Something went wrong. Try again.');
    },
  });

  function setField(field: keyof PasswordFormValues) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setValues((prev) => ({ ...prev, [field]: event.target.value }));
    };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJustChanged(false);

    const result = passwordFormSchema.safeParse(values);
    if (!result.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof PasswordFormValues | undefined;
        if (field && !nextErrors[field]) {
          nextErrors[field] = issue.message;
        }
      }
      setFieldErrors(nextErrors);
      setFormError(null);
      const firstInvalid = FIELD_ORDER.find((field) => nextErrors[field]);
      if (firstInvalid) fieldRefs[firstInvalid].current?.focus();
      return;
    }

    setFieldErrors({});
    setFormError(null);
    mutation.mutate({
      currentPassword: result.data.currentPassword,
      newPassword: result.data.newPassword,
    });
  }

  if (!user) return null;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow tone="silver" size="label">
          Account
        </Eyebrow>
        <Heading level={1} scale="heading-lg">
          {user.name ?? user.email}
        </Heading>
      </div>

      {user.mustChangePassword && (
        <p
          role="alert"
          className="rounded-card border border-surface-slate bg-surface-deep p-6 font-ui text-ui text-text-platinum"
        >
          You must change your password before you can continue.
        </p>
      )}

      <Surface padding="card" className="flex flex-col gap-6">
        <Heading level={2}>Profile</Heading>
        <dl className="grid gap-6 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <dt className="font-display text-caption font-normal uppercase text-text-silver">
              Name
            </dt>
            <dd className="font-ui text-ui text-text-platinum">
              {user.name ?? 'Not set'}
            </dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="font-display text-caption font-normal uppercase text-text-silver">
              Email
            </dt>
            <dd className="font-ui text-ui text-text-platinum">{user.email}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="font-display text-caption font-normal uppercase text-text-silver">
              Roles
            </dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {user.roles.map((role) => (
                <StatusTag key={role} status={role} showDot={false} />
              ))}
            </dd>
          </div>
        </dl>
      </Surface>

      <Surface padding="card" className="flex flex-col gap-6">
        <Heading level={2}>Change password</Heading>
        <form
          noValidate
          onSubmit={handleSubmit}
          className="flex max-w-sm flex-col gap-5"
        >
          <Field label="Current password" error={fieldErrors.currentPassword}>
            <input
              ref={currentPasswordRef}
              type="password"
              autoComplete="current-password"
              value={values.currentPassword}
              onChange={setField('currentPassword')}
            />
          </Field>

          <Field
            label="New password"
            error={fieldErrors.newPassword}
            hint="At least 12 characters."
          >
            <input
              ref={newPasswordRef}
              type="password"
              autoComplete="new-password"
              value={values.newPassword}
              onChange={setField('newPassword')}
            />
          </Field>

          <Field
            label="Confirm new password"
            error={fieldErrors.confirmPassword}
          >
            <input
              ref={confirmPasswordRef}
              type="password"
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={setField('confirmPassword')}
            />
          </Field>

          {formError && (
            <p role="alert" className="font-ui text-ui text-accent-lavender">
              {formError}
            </p>
          )}

          {justChanged && (
            <p role="status" className="font-ui text-ui text-text-mist">
              Your password has been changed. Other sessions have been signed
              out.
            </p>
          )}

          <div>
            <Button type="submit" loading={mutation.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </Surface>
    </div>
  );
}
