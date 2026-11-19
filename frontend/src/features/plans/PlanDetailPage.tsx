import { useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../design/Button';
import { EmptyState } from '../../design/EmptyState';
import { ErrorState } from '../../design/ErrorState';
import { Eyebrow } from '../../design/Eyebrow';
import { Pagination } from '../../design/Pagination';
import { Skeleton } from '../../design/Skeleton';
import { Stat } from '../../design/Stat';
import { StatusTag } from '../../design/StatusTag';
import { Surface } from '../../design/Surface';
import { Table, type TableColumn } from '../../design/Table';
import { getAsset } from '../assets/api';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { can } from '../../lib/auth/roles';
import { useSession } from '../../lib/auth/session';
import { formatDateTime } from '../../lib/format';
import { listWorkOrders, type WorkOrder } from '../work-orders/api';
import { EditPlanDialog } from './EditPlanDialog';
import { getMaintenancePlan, type MaintenanceTask } from './api';

const WORK_ORDERS_PAGE_SIZE = 10;

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? toUserMessage(error).message
    : 'Could not load this right now.';
}

function workOrderReference(id: string): string {
  return `#${id.slice(0, 8).toUpperCase()}`;
}

function toTitleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

interface NumberedTask extends MaintenanceTask {
  position: number;
}

export default function PlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useSession();
  const roles = user?.roles ?? [];
  const [searchParams, setSearchParams] = useSearchParams();

  const [editOpen, setEditOpen] = useState(false);

  const page = Number(searchParams.get('page')) || 1;

  const planQuery = useQuery({
    queryKey: ['maintenance-plans', 'detail', id],
    queryFn: () => getMaintenancePlan(id as string),
    enabled: Boolean(id),
  });

  const assetQuery = useQuery({
    queryKey: ['assets', 'detail', planQuery.data?.assetId],
    queryFn: () => getAsset(planQuery.data?.assetId as string),
    enabled: Boolean(planQuery.data),
  });

  const workOrdersQuery = useQuery({
    queryKey: [
      'work-orders',
      'list',
      { maintenancePlanId: id, page, limit: WORK_ORDERS_PAGE_SIZE },
    ],
    queryFn: () =>
      listWorkOrders({
        maintenancePlanId: id as string,
        page,
        limit: WORK_ORDERS_PAGE_SIZE,
      }),
    enabled: planQuery.isSuccess,
  });

  function updatePage(nextPage: number) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('page', String(nextPage));
        return next;
      },
      { replace: true },
    );
  }

  if (planQuery.isPending) {
    return (
      <div className="flex flex-col gap-8">
        <Surface tone="kelp">
          <Skeleton lines={3} height={20} />
        </Surface>
      </div>
    );
  }

  if (planQuery.isError) {
    if (planQuery.error instanceof ApiError && planQuery.error.status === 404) {
      return (
        <EmptyState
          title="Maintenance plan not found"
          body="This maintenance plan doesn't exist or may have been removed."
          action={
            <Button variant="primary" onClick={() => navigate('/plans')}>
              Back to maintenance plans
            </Button>
          }
        />
      );
    }

    return (
      <ErrorState
        error={errorMessage(planQuery.error)}
        onRetry={() => planQuery.refetch()}
      />
    );
  }

  const plan = planQuery.data;
  const canManage = can.manageMaintenancePlans(roles);
  const overdue =
    plan.active && plan.nextDueAt !== null
      ? new Date(plan.nextDueAt).getTime() < Date.now()
      : false;

  const numberedTasks: NumberedTask[] = plan.tasks.map((task, index) => ({
    ...task,
    position: index + 1,
  }));

  const workOrders = workOrdersQuery.data?.data ?? [];
  const meta = workOrdersQuery.data?.meta;

  const taskColumns: TableColumn<NumberedTask>[] = [
    {
      key: 'position',
      header: '#',
      render: (row) => String(row.position),
    },
    { key: 'description', header: 'Task' },
  ];

  const workOrderColumns: TableColumn<WorkOrder>[] = [
    {
      key: 'reference',
      header: 'Work order',
      render: (row) => workOrderReference(row.id),
    },
    {
      key: 'description',
      header: 'Description',
      render: (row) => (
        <span className="block max-w-xs truncate">{row.description}</span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => toTitleCase(row.priority),
    },
    {
      key: 'openedAt',
      header: 'Opened',
      render: (row) => formatDateTime(row.openedAt),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <StatusTag status={row.status} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Button variant="ghost" onClick={() => navigate('/plans')}>
        ← Maintenance plans
      </Button>

      <Surface tone="kelp" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <span className="font-display text-caption font-normal uppercase text-text-silver">
              Maintenance plan
            </span>
            <h1 className="font-display text-subheading font-medium text-text-platinum">
              {plan.name}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusTag status={plan.active ? 'ACTIVE' : 'INACTIVE'} />
            {overdue && <StatusTag status="OVERDUE_MAINTENANCE" />}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            label="Asset"
            loading={assetQuery.isPending}
            value={
              assetQuery.data ? (
                <Link
                  to={`/assets/${plan.assetId}`}
                  className="text-text-mist underline-offset-2 hover:underline"
                >
                  {assetQuery.data.tag}
                </Link>
              ) : (
                '—'
              )
            }
          />
          <Stat label="Interval" value={`${plan.intervalDays} days`} />
          <Stat
            label="Last completed"
            value={
              plan.lastCompletedAt
                ? formatDateTime(plan.lastCompletedAt)
                : 'Never'
            }
          />
          <Stat
            label="Next due"
            value={plan.nextDueAt ? formatDateTime(plan.nextDueAt) : '—'}
          />
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setEditOpen(true)}>Edit</Button>
          </div>
        )}
      </Surface>

      <div className="flex flex-col gap-3">
        <Eyebrow tone="silver" size="label">
          Tasks
        </Eyebrow>
        <Table
          columns={taskColumns}
          rows={numberedTasks}
          empty="No tasks defined for this plan yet."
          rowKey={(row) => row.id}
        />
      </div>

      <div className="flex flex-col gap-3">
        <Eyebrow tone="silver" size="label">
          Work order history
        </Eyebrow>
        {workOrdersQuery.isError ? (
          <ErrorState
            error={errorMessage(workOrdersQuery.error)}
            onRetry={() => workOrdersQuery.refetch()}
          />
        ) : (
          <>
            <Table
              columns={workOrderColumns}
              rows={workOrders}
              loading={workOrdersQuery.isPending}
              empty="No work orders have been raised from this plan yet."
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/work-orders/${row.id}`)}
            />

            {meta && <Pagination meta={meta} onPageChange={updatePage} />}
          </>
        )}
      </div>

      <EditPlanDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        plan={plan}
      />
    </div>
  );
}
