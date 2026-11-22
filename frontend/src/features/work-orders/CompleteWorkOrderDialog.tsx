import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../design/Button';
import { Dialog } from '../../design/Dialog';
import { Field } from '../../design/Field';
import { Select, type SelectOption } from '../../design/Select';
import { ApiError, toUserMessage } from '../../lib/api/errors';
import { listAllSpareParts } from '../spare-parts/api';
import {
  completeWorkOrder,
  type CompleteWorkOrderPartInput,
  type WorkOrder,
} from './api';

export interface CompleteWorkOrderDialogProps {
  open: boolean;
  onClose: () => void;
  workOrderId: string;
  onCompleted: (workOrder: WorkOrder) => void;
  onConflict?: () => void;
}

interface PartRow {
  key: number;
  sparePartId: string;
  quantity: string;
}

interface RowErrors {
  sparePartId?: string;
  quantity?: string;
}

const MAX_QUANTITY = 1_000_000;

function omitKey(
  errors: Record<number, RowErrors>,
  key: number,
): Record<number, RowErrors> {
  return Object.fromEntries(
    Object.entries(errors).filter(([k]) => Number(k) !== key),
  );
}

function validateRows(rows: PartRow[]): {
  errors: Record<number, RowErrors>;
  parts: CompleteWorkOrderPartInput[];
} {
  const errors: Record<number, RowErrors> = {};
  const parts: CompleteWorkOrderPartInput[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const rowErrors: RowErrors = {};
    const quantity = row.quantity.trim();

    if (!row.sparePartId) {
      rowErrors.sparePartId = 'Select a part';
    } else if (seen.has(row.sparePartId)) {
      rowErrors.sparePartId =
        'This part is already listed. Adjust its quantity instead';
    } else {
      seen.add(row.sparePartId);
    }

    if (!quantity) {
      rowErrors.quantity = 'Quantity is required';
    } else if (!/^\d+$/.test(quantity)) {
      rowErrors.quantity = 'Quantity must be a whole number';
    } else if (Number(quantity) < 1) {
      rowErrors.quantity = 'Quantity must be at least 1';
    } else if (Number(quantity) > MAX_QUANTITY) {
      rowErrors.quantity = 'Quantity must be 1,000,000 or fewer';
    }

    if (rowErrors.sparePartId || rowErrors.quantity) {
      errors[row.key] = rowErrors;
    } else {
      parts.push({
        sparePartId: row.sparePartId,
        quantityUsed: Number(quantity),
      });
    }
  }

  return { errors, parts };
}

export function CompleteWorkOrderDialog({
  open,
  onClose,
  workOrderId,
  onCompleted,
  onConflict,
}: CompleteWorkOrderDialogProps) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<PartRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [rowErrors, setRowErrors] = useState<Record<number, RowErrors>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const partsQuery = useQuery({
    queryKey: ['spare-parts', 'all'],
    queryFn: listAllSpareParts,
    enabled: open,
  });

  const partsById = new Map((partsQuery.data ?? []).map((p) => [p.id, p]));
  const partOptions: SelectOption[] = (partsQuery.data ?? []).map((part) => ({
    value: part.id,
    label: `${part.sku} — ${part.name}`,
  }));

  const mutation = useMutation({
    mutationFn: (parts: CompleteWorkOrderPartInput[]) =>
      completeWorkOrder(workOrderId, { parts }),
    onSuccess: (workOrder) => {
      // Stock, ledger and low-stock alerts all change when parts are consumed.
      void queryClient.invalidateQueries({ queryKey: ['spare-parts'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      handleClose();
      onCompleted(workOrder);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setFormError(toUserMessage(error).message);
        if (error.status === 409) {
          // Stock (or the work order's status) changed underneath us.
          void queryClient.invalidateQueries({ queryKey: ['spare-parts'] });
          onConflict?.();
        }
      } else {
        setFormError('Could not complete this work order. Try again.');
      }
    },
  });

  function reset() {
    setRows([]);
    setRowErrors({});
    setFormError(null);
  }

  function handleClose() {
    reset();
    mutation.reset();
    onClose();
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { key: nextKey, sparePartId: '', quantity: '1' },
    ]);
    setNextKey((key) => key + 1);
  }

  function updateRow(key: number, patch: Partial<PartRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
    setRowErrors((current) => {
      if (!current[key]) return current;
      return omitKey(current, key);
    });
    setFormError(null);
  }

  function removeRow(key: number) {
    setRows((current) => current.filter((row) => row.key !== key));
    setRowErrors((current) => {
      return omitKey(current, key);
    });
    setFormError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const { errors, parts } = validateRows(rows);
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      setFormError(null);
      return;
    }

    setRowErrors({});
    setFormError(null);
    mutation.mutate(parts);
  }

  return (
    <Dialog
      open={open}
      title="Complete work order"
      onClose={handleClose}
      className="max-h-[90vh] overflow-y-auto"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        <p className="font-display text-body font-normal text-text-silver">
          Record the spare parts used. Stock is reduced when you complete the
          work order.
        </p>

        {partsQuery.isError && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="font-ui text-ui text-accent-lavender">
              Could not load spare parts.
            </p>
            <div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void partsQuery.refetch()}
              >
                Retry loading parts
              </Button>
            </div>
          </div>
        )}

        {rows.length === 0 && (
          <p className="font-ui text-ui text-text-silver">
            No parts recorded. Add a part if any were used.
          </p>
        )}

        {rows.map((row, index) => {
          const selected = partsById.get(row.sparePartId);
          const errors = rowErrors[row.key] ?? {};
          return (
            <fieldset
              key={row.key}
              className="flex flex-col gap-3 rounded-small border border-surface-slate p-3"
            >
              <legend className="px-1 font-display text-caption font-normal uppercase text-text-silver">
                Part {index + 1}
              </legend>
              <Field label={`Part ${index + 1}`} error={errors.sparePartId}>
                <Select
                  searchable
                  options={partOptions}
                  value={row.sparePartId}
                  placeholder={
                    partsQuery.isPending ? 'Loading parts…' : 'Search parts'
                  }
                  disabled={partsQuery.isPending}
                  onChange={(value) =>
                    updateRow(row.key, { sparePartId: value })
                  }
                />
              </Field>
              <Field
                label={`Quantity used ${index + 1}`}
                error={errors.quantity}
                hint={
                  selected ? `${selected.quantityOnHand} on hand` : undefined
                }
              >
                <input
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  step={1}
                  value={row.quantity}
                  onChange={(event) =>
                    updateRow(row.key, { quantity: event.target.value })
                  }
                />
              </Field>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeRow(row.key)}
                  aria-label={`Remove part ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            </fieldset>
          );
        })}

        <div>
          <Button
            type="button"
            variant="ghost"
            onClick={addRow}
            disabled={partsQuery.isPending || partsQuery.isError}
          >
            Add part
          </Button>
        </div>

        {formError && (
          <p role="alert" className="font-ui text-ui text-accent-lavender">
            {formError}
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Keep working
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Complete work order
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
