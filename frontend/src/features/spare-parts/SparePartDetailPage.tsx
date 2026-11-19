import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';
import { EmptyState } from '../../design/EmptyState';
import { ErrorState } from '../../design/ErrorState';
import { Eyebrow } from '../../design/Eyebrow';
import { Pagination } from '../../design/Pagination';
import { Skeleton } from '../../design/Skeleton';
import { Stat } from '../../design/Stat';
import { StatusTag } from '../../design/StatusTag';
import { Surface } from '../../design/Surface';
import { Table, type TableColumn } from '../../design/Table';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { can } from '../../lib/auth/roles';
import { useSession } from '../../lib/auth/session';
import { formatCurrency, formatDateTime, formatNumber } from '../../lib/format';
import { AdjustSparePartDialog } from './AdjustSparePartDialog';
import { RestockSparePartDialog } from './RestockSparePartDialog';
import {
  deleteSparePart,
  getSparePart,
  listSparePartTransactions,
  type InventoryTransaction,
} from './api';

const TRANSACTIONS_PAGE_SIZE = 10;

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? toUserMessage(error).message
    : 'Could not load this right now.';
}

function shortId(id: string): string {
  return `#${id.slice(0, 8).toUpperCase()}`;
}

function actorLabel(createdByUserId: string | null): string {
  return createdByUserId === null
    ? 'System'
    : `User ${shortId(createdByUserId)}`;
}

function toTitleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
}

export default function SparePartDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const roles = user?.roles ?? [];
  const [searchParams, setSearchParams] = useSearchParams();

  const [restockOpen, setRestockOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const page = Number(searchParams.get('page')) || 1;

  const partQuery = useQuery({
    queryKey: ['spare-parts', 'detail', id],
    queryFn: () => getSparePart(id as string),
    enabled: Boolean(id),
  });

  const transactionsQuery = useQuery({
    queryKey: [
      'spare-parts',
      'transactions',
      id,
      { page, limit: TRANSACTIONS_PAGE_SIZE },
    ],
    queryFn: () =>
      listSparePartTransactions(id as string, {
        page,
        limit: TRANSACTIONS_PAGE_SIZE,
      }),
    enabled: partQuery.isSuccess,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSparePart(id as string),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['spare-parts'] });
      navigate('/spare-parts');
    },
    onError: (error) => {
      setDeleteError(
        error instanceof ApiError
          ? toUserMessage(error).message
          : 'Could not delete this part. Try again.',
      );
    },
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

  if (partQuery.isPending) {
    return (
      <div className="flex flex-col gap-8">
        <Surface tone="kelp">
          <Skeleton lines={3} height={20} />
        </Surface>
      </div>
    );
  }

  if (partQuery.isError) {
    if (partQuery.error instanceof ApiError && partQuery.error.status === 404) {
      return (
        <EmptyState
          title="Spare part not found"
          body="This spare part doesn't exist or may have been removed."
          action={
            <Button variant="primary" onClick={() => navigate('/spare-parts')}>
              Back to spare parts
            </Button>
          }
        />
      );
    }

    return (
      <ErrorState
        error={errorMessage(partQuery.error)}
        onRetry={() => partQuery.refetch()}
      />
    );
  }

  const part = partQuery.data;
  const canAdjust = can.adjustStock(roles);
  const canDelete = can.manageSpareParts(roles);
  const totalValue =
    Math.round(part.quantityOnHand * part.unitCost * 100) / 100;

  const transactions = transactionsQuery.data?.data ?? [];
  const meta = transactionsQuery.data?.meta;

  const columns: TableColumn<InventoryTransaction>[] = [
    {
      key: 'createdAt',
      header: 'Time',
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: 'reason',
      header: 'Type',
      render: (row) => toTitleCase(row.reason),
    },
    {
      key: 'deltaQuantity',
      header: 'Quantity change',
      align: 'right',
      render: (row) => formatDelta(row.deltaQuantity),
    },
    {
      key: 'quantityAfter',
      header: 'Quantity after',
      align: 'right',
      render: (row) => formatNumber(row.quantityAfter),
    },
    {
      key: 'createdByUserId',
      header: 'Actor',
      align: 'right',
      render: (row) => actorLabel(row.createdByUserId),
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Button variant="ghost" onClick={() => navigate('/spare-parts')}>
        ← Spare parts
      </Button>

      <Surface tone="kelp" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <span className="font-display text-caption font-normal uppercase text-text-silver">
              {part.sku}
            </span>
            <h1 className="font-display text-subheading font-medium text-text-platinum">
              {part.name}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            {part.isOutOfStock ? (
              <StatusTag status="OUT" />
            ) : part.isLowStock ? (
              <StatusTag status="LOW_STOCK" />
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            label="Quantity on hand"
            value={formatNumber(part.quantityOnHand)}
          />
          <Stat
            label="Reorder threshold"
            value={formatNumber(part.reorderThreshold)}
          />
          <Stat label="Unit cost" value={formatCurrency(part.unitCost)} />
          <Stat label="Total stock value" value={formatCurrency(totalValue)} />
        </div>

        {(canAdjust || canDelete) && (
          <div className="flex flex-wrap items-center gap-3">
            {canAdjust && (
              <>
                <Button onClick={() => setRestockOpen(true)}>Restock</Button>
                <Button variant="ghost" onClick={() => setAdjustOpen(true)}>
                  Adjust
                </Button>
              </>
            )}
            {canDelete && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        )}
      </Surface>

      <div className="flex flex-col gap-3">
        <Eyebrow tone="silver" size="label">
          Transaction history
        </Eyebrow>
        {transactionsQuery.isError ? (
          <ErrorState
            error={errorMessage(transactionsQuery.error)}
            onRetry={() => transactionsQuery.refetch()}
          />
        ) : (
          <>
            <Table
              columns={columns}
              rows={transactions}
              loading={transactionsQuery.isPending}
              empty="No stock movements recorded for this part yet."
              rowKey={(row) => row.id}
            />

            {meta && <Pagination meta={meta} onPageChange={updatePage} />}
          </>
        )}
      </div>

      <RestockSparePartDialog
        open={restockOpen}
        onClose={() => setRestockOpen(false)}
        part={part}
      />

      <AdjustSparePartDialog
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        part={part}
      />

      <Dialog
        open={deleteOpen}
        title={`Delete ${part.sku}?`}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteError(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteOpen(false);
                setDeleteError(null);
              }}
            >
              Keep part
            </Button>
            <Button
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              Delete part
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="font-display text-body font-normal text-text-silver">
            This removes {part.name} ({part.sku}) from the catalog. This cannot
            be undone.
          </p>
          {deleteError && (
            <p role="alert" className="font-ui text-ui text-accent-lavender">
              {deleteError}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
