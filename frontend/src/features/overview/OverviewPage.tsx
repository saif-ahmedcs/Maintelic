import { IconArrowRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from '../../design/ErrorBoundary';
import { ErrorState } from '../../design/ErrorState';
import { Eyebrow } from '../../design/Eyebrow';
import { Heading } from '../../design/Heading';
import { Icon } from '../../design/Icon';
import { NavLink } from '../../design/NavLink';
import { Skeleton } from '../../design/Skeleton';
import { Stat } from '../../design/Stat';
import { Surface } from '../../design/Surface';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { formatNumber } from '../../lib/format';
import { listAssets } from '../assets/api';
import { listDuePlans } from '../plans/api';
import { listSpareParts } from '../spare-parts/api';
import { getTelemetrySummary } from '../telemetry/api';
import { listWorkOrders } from '../work-orders/api';
import { WorkOrderRow } from '../work-orders/WorkOrderRow';
import { AlertsPanel } from './AlertsPanel';

const POLL_INTERVAL_MS = 30_000;

function tileErrorMessage(error: unknown): string {
  return error instanceof ApiError
    ? toUserMessage(error).message
    : 'Could not load this right now.';
}

interface CounterTileProps {
  label: string;
  total: number | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}

function CounterTileContent({
  label,
  total,
  isPending,
  isError,
  error,
  onRetry,
}: CounterTileProps) {
  if (isError) {
    return (
      <Surface tone="kelp" className="flex flex-col gap-3">
        <span className="font-display text-meta font-normal uppercase text-text-silver">
          {label}
        </span>
        <ErrorState error={tileErrorMessage(error)} onRetry={onRetry} />
      </Surface>
    );
  }

  return (
    <Surface tone="kelp">
      <Stat
        label={label}
        loading={isPending}
        value={total === undefined ? undefined : formatNumber(total)}
      />
    </Surface>
  );
}

function CounterTile(props: CounterTileProps) {
  return (
    <ErrorBoundary fallbackMessage={`Could not show "${props.label}."`}>
      <CounterTileContent {...props} />
    </ErrorBoundary>
  );
}

export default function OverviewPage() {
  const openWorkOrders = useQuery({
    queryKey: ['work-orders', 'list', { status: 'OPEN', limit: 1 }],
    queryFn: () => listWorkOrders({ status: 'OPEN', limit: 1 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const criticalAssets = useQuery({
    queryKey: ['assets', 'list', { status: 'CRITICAL', limit: 1 }],
    queryFn: () => listAssets({ status: 'CRITICAL', limit: 1 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const overduePlans = useQuery({
    queryKey: ['maintenance-plans', 'due', { limit: 1 }],
    queryFn: () => listDuePlans({ limit: 1 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const lowStockParts = useQuery({
    queryKey: ['spare-parts', 'list', { lowStock: true, limit: 1 }],
    queryFn: () => listSpareParts({ lowStock: true, limit: 1 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const telemetrySummary = useQuery({
    queryKey: ['telemetry', 'summary'],
    queryFn: () => getTelemetrySummary(),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const workOrderQueue = useQuery({
    queryKey: ['work-orders', 'list', { status: 'OPEN', limit: 5 }],
    queryFn: () => listWorkOrders({ status: 'OPEN', limit: 5 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const queueItems = workOrderQueue.data?.data ?? [];
  const queueTotal = workOrderQueue.data?.meta.total ?? 0;

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-col gap-2">
        <Eyebrow tone="silver" size="label">
          Plant overview
        </Eyebrow>
        <Heading level={1} scale="heading">
          Overview
        </Heading>
      </div>

      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
        <CounterTile
          label="Open work orders"
          total={openWorkOrders.data?.meta.total}
          isPending={openWorkOrders.isPending}
          isError={openWorkOrders.isError}
          error={openWorkOrders.error}
          onRetry={() => openWorkOrders.refetch()}
        />
        <CounterTile
          label="Critical assets"
          total={criticalAssets.data?.meta.total}
          isPending={criticalAssets.isPending}
          isError={criticalAssets.isError}
          error={criticalAssets.error}
          onRetry={() => criticalAssets.refetch()}
        />
        <CounterTile
          label="Overdue plans"
          total={overduePlans.data?.meta.total}
          isPending={overduePlans.isPending}
          isError={overduePlans.isError}
          error={overduePlans.error}
          onRetry={() => overduePlans.refetch()}
        />
        <CounterTile
          label="Low-stock parts"
          total={lowStockParts.data?.meta.total}
          isPending={lowStockParts.isPending}
          isError={lowStockParts.isError}
          error={lowStockParts.error}
          onRetry={() => lowStockParts.refetch()}
        />
        <CounterTile
          label="Readings last hour"
          total={telemetrySummary.data?.readingCount}
          isPending={telemetrySummary.isPending}
          isError={telemetrySummary.isError}
          error={telemetrySummary.error}
          onRetry={() => telemetrySummary.refetch()}
        />
      </div>

      <div className="flex flex-col gap-6">
        <Surface
          tone="deep"
          className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-9"
        >
          <div className="flex flex-col gap-3">
            <Eyebrow tone="silver" size="label">
              Telemetry
            </Eyebrow>
            <p className="font-display text-body font-normal text-text-silver">
              Live readings and the trend chart for any asset are on the
              Telemetry page.
            </p>
          </div>
          <NavLink
            to="/telemetry"
            className="inline-flex shrink-0 items-center gap-1.5 self-start hover:text-text-platinum sm:self-center"
          >
            Open live telemetry
            <Icon icon={IconArrowRight} size={16} />
          </NavLink>
        </Surface>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Surface tone="kelp" padding="none" className="xl:col-span-2">
            <div className="px-9 pt-9">
              <Eyebrow tone="silver" size="label">
                Work order queue
              </Eyebrow>
            </div>

            <div className="px-9 pb-9">
              <ErrorBoundary fallbackMessage="Could not show the work order queue.">
                {workOrderQueue.isError ? (
                  <ErrorState
                    error={tileErrorMessage(workOrderQueue.error)}
                    onRetry={() => workOrderQueue.refetch()}
                    className="pt-6"
                  />
                ) : workOrderQueue.isPending ? (
                  <div className="pt-6">
                    <Skeleton lines={5} height={20} />
                  </div>
                ) : queueItems.length === 0 ? (
                  <p className="pt-6 font-display text-body font-normal text-text-silver">
                    No open work orders. Create one from an asset page.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-col">
                      {queueItems.map((workOrder) => (
                        <WorkOrderRow
                          key={workOrder.id}
                          workOrder={workOrder}
                        />
                      ))}
                    </div>
                    <div className="border-t border-surface-abyss pt-5">
                      <NavLink
                        to="/work-orders?status=OPEN"
                        className="flex items-center justify-between gap-4 hover:text-text-platinum"
                      >
                        {queueTotal > queueItems.length
                          ? `View all ${formatNumber(queueTotal)} open work orders`
                          : 'View all open work orders'}
                        <Icon icon={IconArrowRight} size={16} />
                      </NavLink>
                    </div>
                  </>
                )}
              </ErrorBoundary>
            </div>
          </Surface>

          <AlertsPanel className="xl:col-span-1" />
        </div>
      </div>
    </div>
  );
}
