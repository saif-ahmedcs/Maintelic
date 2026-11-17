import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';
import { Field } from '../../design/Field';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import type { Role } from '../auth/api';
import { createUser, type TemporaryPasswordResult } from './api';
import { RoleCheckboxes } from './RoleCheckboxes';

export interface CreateUserDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (result: TemporaryPasswordResult) => void;
}

const createUserFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(255, 'Name must be 255 characters or fewer'),
  email: z
    .string()
    .trim()
    .min(1, 'Email is required')
    .email('Enter a valid email address'),
});

type CreateUserFormValues = z.infer<typeof createUserFormSchema>;
type FieldErrors = Partial<Record<keyof CreateUserFormValues, string>>;

const EMPTY_VALUES: CreateUserFormValues = { name: '', email: '' };

export function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: CreateUserDialogProps) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<CreateUserFormValues>(EMPTY_VALUES);
  const [roles, setRoles] = useState<Role[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: createUser,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      handleClose();
      onCreated(result);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const { field, message } = toUserMessage(error);
        if (field === 'roles') {
          setRolesError(message);
          setFieldErrors({});
          setFormError(null);
        } else if (field && field in EMPTY_VALUES) {
          setFieldErrors({ [field]: message } as FieldErrors);
          setRolesError(null);
          setFormError(null);
        } else {
          setFormError(message);
        }
      } else {
        setFormError('Something went wrong. Try again.');
      }
    },
  });

  function handleClose() {
    setValues(EMPTY_VALUES);
    setRoles([]);
    setFieldErrors({});
    setRolesError(null);
    setFormError(null);
    onClose();
  }

  function setField<K extends keyof CreateUserFormValues>(
    key: K,
    value: CreateUserFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = createUserFormSchema.safeParse(values);
    const nextErrors: FieldErrors = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof CreateUserFormValues | undefined;
        if (key && !nextErrors[key]) {
          nextErrors[key] = issue.message;
        }
      }
    }

    const nextRolesError =
      roles.length === 0 ? 'Select at least one role' : null;

    if (!result.success || nextRolesError) {
      setFieldErrors(nextErrors);
      setRolesError(nextRolesError);
      setFormError(null);
      if (nextErrors.name) nameRef.current?.focus();
      return;
    }

    setFieldErrors({});
    setRolesError(null);
    setFormError(null);

    mutation.mutate({
      name: result.data.name,
      email: result.data.email,
      roles,
    });
  }

  return (
    <Dialog open={open} title="Add user" onClose={handleClose}>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <Field label="Name" error={fieldErrors.name}>
          <input
            ref={nameRef}
            type="text"
            placeholder="Jordan Reyes"
            value={values.name}
            onChange={(event) => setField('name', event.target.value)}
          />
        </Field>

        <Field label="Email" error={fieldErrors.email}>
          <input
            type="email"
            placeholder="supervisor@example.com"
            value={values.email}
            onChange={(event) => setField('email', event.target.value)}
          />
        </Field>

        <RoleCheckboxes
          legend="Roles"
          selected={roles}
          onChange={setRoles}
          error={rolesError ?? undefined}
        />

        {formError && (
          <p role="alert" className="font-ui text-ui text-accent-lavender">
            {formError}
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Add user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
