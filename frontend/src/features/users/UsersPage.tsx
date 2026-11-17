import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';
import { ErrorState } from '../../design/ErrorState';
import { Eyebrow } from '../../design/Eyebrow';
import { Field } from '../../design/Field';
import { Heading } from '../../design/Heading';
import { Pagination } from '../../design/Pagination';
import { Select, type SelectOption } from '../../design/Select';
import { StatusTag } from '../../design/StatusTag';
import { Table, type TableColumn } from '../../design/Table';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import type { Role } from '../auth/api';
import {
  listUsers,
  resetUserPassword,
  updateUser,
  type TemporaryPasswordResult,
  type User,
} from './api';
import { CreateUserDialog } from './CreateUserDialog';
import { EditRolesDialog } from './EditRolesDialog';
import { TemporaryPasswordDialog } from './TemporaryPasswordDialog';

const DEFAULT_SORT_BY = 'user.email';
const DEFAULT_SORT_DIR = 'ASC';

const ROLE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All roles' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'TECHNICIAN', label: 'Technician' },
  { value: 'VIEWER', label: 'Viewer' },
];

const ACTIVE_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const SORT_BY_OPTIONS: SelectOption[] = [
  { value: 'user.email', label: 'Email' },
  { value: 'user.name', label: 'Name' },
  { value: 'user.createdAt', label: 'Created' },
];

const SORT_DIR_OPTIONS: SelectOption[] = [
  { value: 'ASC', label: 'Ascending' },
  { value: 'DESC', label: 'Descending' },
];

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? toUserMessage(error).message
    : 'Could not load users right now.';
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [createOpen, setCreateOpen] = useState(false);
  const [editRolesTarget, setEditRolesTarget] = useState<User | null>(null);
  const [toggleActiveTarget, setToggleActiveTarget] = useState<User | null>(
    null,
  );
  const [toggleActiveError, setToggleActiveError] = useState<string | null>(
    null,
  );
  const [resetPasswordTarget, setResetPasswordTarget] = useState<User | null>(
    null,
  );
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(
    null,
  );
  const [temporaryPasswordResult, setTemporaryPasswordResult] =
    useState<TemporaryPasswordResult | null>(null);

  const page = Number(searchParams.get('page')) || 1;
  const role = searchParams.get('role') ?? '';
  const active = searchParams.get('active') ?? '';
  const sortBy = searchParams.get('sortBy') ?? DEFAULT_SORT_BY;
  const sortDir = searchParams.get('sortDir') ?? DEFAULT_SORT_DIR;

  function updateParams(
    patch: Record<string, string | undefined>,
    options: { resetPage?: boolean } = {},
  ) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) {
            next.set(key, value);
          } else {
            next.delete(key);
          }
        }
        if (options.resetPage) {
          next.delete('page');
        }
        return next;
      },
      { replace: true },
    );
  }

  const usersQuery = useQuery({
    queryKey: ['users', 'list', { page, role, active, sortBy, sortDir }],
    queryFn: () =>
      listUsers({
        page,
        role: (role || undefined) as Role | undefined,
        active: active === '' ? undefined : active === 'true',
        sortBy,
        sortDir: sortDir as 'ASC' | 'DESC',
      }),
  });

  function invalidateUsersList() {
    void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
  }

  const toggleActiveMutation = useMutation({
    mutationFn: (user: User) => updateUser(user.id, { active: !user.isActive }),
    onSuccess: () => {
      invalidateUsersList();
      setToggleActiveTarget(null);
      setToggleActiveError(null);
    },
    onError: (error) => {
      setToggleActiveError(
        error instanceof ApiError
          ? toUserMessage(error).message
          : 'Could not update this user. Try again.',
      );
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (user: User) => resetUserPassword(user.id),
    onSuccess: (result) => {
      invalidateUsersList();
      setResetPasswordTarget(null);
      setResetPasswordError(null);
      setTemporaryPasswordResult(result);
    },
    onError: (error) => {
      setResetPasswordError(
        error instanceof ApiError
          ? toUserMessage(error).message
          : 'Could not reset this password. Try again.',
      );
    },
  });

  const columns: TableColumn<User>[] = [
    { key: 'name', header: 'Name', render: (row) => row.name ?? '—' },
    { key: 'email', header: 'Email' },
    {
      key: 'roles',
      header: 'Roles',
      render: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.roles.map((roleName) => (
            <StatusTag key={roleName} status={roleName} showDot={false} />
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusTag status={row.isActive ? 'ACTIVE' : 'INACTIVE'} />
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (row) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              setEditRolesTarget(row);
            }}
          >
            Edit roles
          </Button>
          <Button
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              setToggleActiveError(null);
              setToggleActiveTarget(row);
            }}
          >
            {row.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
          <Button
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              setResetPasswordError(null);
              setResetPasswordTarget(row);
            }}
          >
            Reset password
          </Button>
        </div>
      ),
    },
  ];

  const users = usersQuery.data?.data ?? [];
  const meta = usersQuery.data?.meta;
  const willActivate = toggleActiveTarget
    ? !toggleActiveTarget.isActive
    : false;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow tone="silver" size="label">
            Administration
          </Eyebrow>
          <Heading level={1} scale="heading">
            Users
          </Heading>
        </div>

        <Button onClick={() => setCreateOpen(true)}>Add user</Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Role" className="w-44">
          <Select
            options={ROLE_FILTER_OPTIONS}
            value={role}
            onChange={(value) =>
              updateParams({ role: value }, { resetPage: true })
            }
          />
        </Field>

        <Field label="Status" className="w-40">
          <Select
            options={ACTIVE_FILTER_OPTIONS}
            value={active}
            onChange={(value) =>
              updateParams({ active: value }, { resetPage: true })
            }
          />
        </Field>

        <Field label="Sort by" className="w-44">
          <Select
            options={SORT_BY_OPTIONS}
            value={sortBy}
            onChange={(value) => updateParams({ sortBy: value })}
          />
        </Field>

        <Field label="Direction" className="w-36">
          <Select
            options={SORT_DIR_OPTIONS}
            value={sortDir}
            onChange={(value) => updateParams({ sortDir: value })}
          />
        </Field>
      </div>

      {usersQuery.isError ? (
        <ErrorState
          error={errorMessage(usersQuery.error)}
          onRetry={() => usersQuery.refetch()}
        />
      ) : (
        <>
          <Table
            columns={columns}
            rows={users}
            loading={usersQuery.isPending}
            empty="No users yet. Add one to get started."
            rowKey={(row) => row.id}
          />

          {meta && (
            <Pagination
              meta={meta}
              onPageChange={(nextPage) =>
                updateParams({ page: String(nextPage) })
              }
            />
          )}
        </>
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => setTemporaryPasswordResult(result)}
      />

      <EditRolesDialog
        open={Boolean(editRolesTarget)}
        onClose={() => setEditRolesTarget(null)}
        user={editRolesTarget}
      />

      <Dialog
        open={Boolean(toggleActiveTarget)}
        title={
          willActivate
            ? `Reactivate ${toggleActiveTarget?.name ?? toggleActiveTarget?.email ?? ''}?`
            : `Deactivate ${toggleActiveTarget?.name ?? toggleActiveTarget?.email ?? ''}?`
        }
        onClose={() => {
          setToggleActiveTarget(null);
          setToggleActiveError(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setToggleActiveTarget(null);
                setToggleActiveError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              loading={toggleActiveMutation.isPending}
              onClick={() =>
                toggleActiveTarget &&
                toggleActiveMutation.mutate(toggleActiveTarget)
              }
            >
              {willActivate ? 'Reactivate' : 'Deactivate'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="font-display text-body font-normal text-text-silver">
            {willActivate
              ? 'This restores sign-in access for this user.'
              : 'This immediately signs this user out everywhere and ' +
                'prevents them from signing in again until reactivated.'}
          </p>
          {toggleActiveError && (
            <p role="alert" className="font-ui text-ui text-accent-lavender">
              {toggleActiveError}
            </p>
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(resetPasswordTarget)}
        title={`Reset password for ${resetPasswordTarget?.name ?? resetPasswordTarget?.email ?? ''}?`}
        onClose={() => {
          setResetPasswordTarget(null);
          setResetPasswordError(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setResetPasswordTarget(null);
                setResetPasswordError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              loading={resetPasswordMutation.isPending}
              onClick={() =>
                resetPasswordTarget &&
                resetPasswordMutation.mutate(resetPasswordTarget)
              }
            >
              Reset password
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="font-display text-body font-normal text-text-silver">
            This generates a new temporary password and signs this user out
            everywhere. They will need to change it at next sign-in.
          </p>
          {resetPasswordError && (
            <p role="alert" className="font-ui text-ui text-accent-lavender">
              {resetPasswordError}
            </p>
          )}
        </div>
      </Dialog>

      {temporaryPasswordResult && (
        <TemporaryPasswordDialog
          open
          onClose={() => setTemporaryPasswordResult(null)}
          email={temporaryPasswordResult.user.email}
          temporaryPassword={temporaryPasswordResult.temporaryPassword}
        />
      )}
    </div>
  );
}
