import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';
import { ApiError } from '../../lib/api/errors';
import type { Role } from '../auth/api';
import { updateUserRoles, type User } from './api';
import { RoleCheckboxes } from './RoleCheckboxes';

export interface EditRolesDialogProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
}

export function EditRolesDialog({ open, onClose, user }: EditRolesDialogProps) {
  const queryClient = useQueryClient();
  const [roles, setRoles] = useState<Role[]>(user?.roles ?? []);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setRoles(user?.roles ?? []);
    setRolesError(null);
    setFormError(null);
  }, [user]);

  const mutation = useMutation({
    mutationFn: (nextRoles: Role[]) => {
      if (!user) throw new Error('No user selected');
      return updateUserRoles(user.id, nextRoles);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.status === 409) {
          setRolesError(error.message);
          setFormError(null);
          return;
        }
        setRolesError(null);
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    },
  });

  function handleClose() {
    setRolesError(null);
    setFormError(null);
    onClose();
  }

  function handleSubmit() {
    if (!user) return;

    if (roles.length === 0) {
      setRolesError('Select at least one role');
      setFormError(null);
      return;
    }

    setRolesError(null);
    setFormError(null);
    mutation.mutate(roles);
  }

  if (!user) return null;

  return (
    <Dialog
      open={open}
      title={`Edit roles for ${user.name ?? user.email}`}
      onClose={handleClose}
    >
      <div className="flex flex-col gap-5">
        <RoleCheckboxes
          legend="Roles"
          selected={roles}
          onChange={setRoles}
          error={rolesError ?? undefined}
          hint="The last active admin cannot be removed."
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
          <Button
            type="button"
            loading={mutation.isPending}
            onClick={handleSubmit}
          >
            Save roles
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
