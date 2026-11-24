import { IconArrowRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorBoundary } from '../../design/ErrorBoundary';
import { ErrorState } from '../../design/ErrorState';
import { Eyebrow } from '../../design/Eyebrow';
import { Icon } from '../../design/Icon';
import { Stat } from '../../design/Stat';
import { Surface } from '../../design/Surface';
import alertsBell from '../../assets/alerts-bell.png';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { formatNumber } from '../../lib/format';
import { listNotifications } from '../alerts/api';

const POLL_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? toUserMessage(error).message
    : 'Could not load this right now.';
}

function summaryText(unreadCount: number, criticalCount: number): string {
  if (unreadCount === 0) return 'No unread alerts right now.';
  if (criticalCount > 0) return 'Critical asset alerts need your attention.';
  return 'Unread alerts are waiting for review.';
}

interface SeverityRowProps {
  label: string;
  count: number;
  dotClassName: string;
}

function SeverityRow({ label, count, dotClassName }: SeverityRowProps) {
  return (
    <li className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-2 font-display text-label font-normal uppercase text-text-silver">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${dotClassName}`}
        />
        {label}
      </span>
      <span className="font-display text-body font-normal tabular-nums text-text-platinum">
        {formatNumber(count)}
      </span>
    </li>
  );
}

function AlertsPanelContent() {
  // Same query key as the nav badge in AppShell, so both share one request.
  const unreadAlerts = useQuery({
    queryKey: ['notifications', 'list', { status: 'UNREAD', limit: 5 }],
    queryFn: () => listNotifications({ status: 'UNREAD', limit: 5 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Only the total is read from this one, so a single row is enough. The
  // severity split is secondary: if it fails, the card still shows the count.
  const criticalAlerts = useQuery({
    queryKey: [
      'notifications',
      'list',
      { status: 'UNREAD', type: 'CRITICAL_ASSET', limit: 1 },
    ],
    queryFn: () =>
      listNotifications({ status: 'UNREAD', type: 'CRITICAL_ASSET', limit: 1 }),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const unreadCount = unreadAlerts.data?.meta.total ?? 0;
  const isClear = unreadAlerts.isSuccess && unreadCount === 0;

  // CRITICAL_ASSET is the critical tier; OVERDUE_MAINTENANCE and LOW_STOCK
  // are the warning tier (see StatusTag).
  const criticalCount = Math.min(
    criticalAlerts.data?.meta.total ?? 0,
    unreadCount,
  );
  const warningCount = unreadCount - criticalCount;
  const showSeverity =
    unreadAlerts.isSuccess &&
    criticalAlerts.isSuccess &&
    unreadCount > 0 &&
    (criticalCount > 0 || warningCount > 0);

  if (unreadAlerts.isError) {
    return (
      <Surface tone="kelp" className="flex flex-1 flex-col gap-6">
        <Eyebrow tone="silver" size="label">
          Alerts
        </Eyebrow>
        <ErrorState
          error={errorMessage(unreadAlerts.error)}
          onRetry={() => unreadAlerts.refetch()}
        />
      </Surface>
    );
  }

  return (
    <Surface
      tone="kelp"
      className="ui-card-link group flex flex-1 flex-col gap-6"
    >
      <Eyebrow tone="silver" size="label">
        Alerts
      </Eyebrow>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-5">
          <div className="flex size-22 shrink-0 items-center justify-center rounded-small bg-surface-deep">
            <img
              src={alertsBell}
              alt=""
              width={384}
              height={303}
              className={[
                'ui-card-link__bell h-13 w-auto transition-[opacity,filter] duration-(--motion-duration-base) ease-standard',
                isClear ? 'opacity-60 saturate-50' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            />
          </div>
          <Stat
            label="Unread alerts"
            loading={unreadAlerts.isPending}
            value={formatNumber(unreadCount)}
          />
        </div>

        {!unreadAlerts.isPending && (
          <p className="font-display text-body font-normal text-text-silver">
            {summaryText(unreadCount, criticalCount)}
          </p>
        )}
      </div>

      {showSeverity && (
        <ul
          aria-label="Unread alerts by severity"
          className="flex flex-col gap-3 rounded-small bg-surface-deep px-4 py-4"
        >
          {criticalCount > 0 && (
            <SeverityRow
              label="Critical"
              count={criticalCount}
              dotClassName="bg-alarm-critical"
            />
          )}
          {warningCount > 0 && (
            <SeverityRow
              label="Warning"
              count={warningCount}
              dotClassName="bg-alarm-warning"
            />
          )}
        </ul>
      )}

      <div className="mt-auto border-t border-surface-abyss pt-5">
        <Link
          to="/alerts"
          className="ui-card-link__anchor flex items-center justify-between gap-4 font-display text-label font-normal uppercase text-text-silver transition-colors duration-(--motion-duration-fast) ease-standard group-hover:text-text-platinum group-has-[a:focus-visible]:text-text-platinum"
        >
          View all alerts
          <Icon
            icon={IconArrowRight}
            size={16}
            className="ui-card-link__arrow"
          />
        </Link>
      </div>
    </Surface>
  );
}

/**
 * Overview alerts summary: the unread count, a severity split and one
 * destination — the Alerts page. Individual alerts are intentionally not
 * listed here; they are worked from the Alerts page.
 */
export function AlertsPanel({ className }: { className?: string }) {
  return (
    <div className={['flex', className].filter(Boolean).join(' ')}>
      <ErrorBoundary
        className="flex-1"
        fallbackMessage="Could not show alerts."
      >
        <AlertsPanelContent />
      </ErrorBoundary>
    </div>
  );
}
