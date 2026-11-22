import { z } from 'zod';
import { request, type QueryParams } from '../../lib/api/client';
import { paginated } from '../../lib/api/pagination';

export const sparePartSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  quantityOnHand: z.number(),
  reorderThreshold: z.number(),
  unitCost: z.number(),
  isLowStock: z.boolean(),
  isOutOfStock: z.boolean(),
});
export type SparePart = z.infer<typeof sparePartSchema>;

export interface ListSparePartsParams extends QueryParams {
  page?: number;
  limit?: number;
  lowStock?: boolean;
  sortBy?: string;
  sortDir?: 'ASC' | 'DESC' | 'asc' | 'desc';
}

/** GET /spare-parts */
export async function listSpareParts(params: ListSparePartsParams = {}) {
  const data = await request<unknown>('/spare-parts', { query: params });
  return paginated(sparePartSchema).parse(data);
}

const ALL_PARTS_PAGE_SIZE = 100; // backend MAX_PAGE_SIZE

/** Walks every page of GET /spare-parts (for pickers that need the full catalogue). */
export async function listAllSpareParts(): Promise<SparePart[]> {
  const first = await listSpareParts({
    page: 1,
    limit: ALL_PARTS_PAGE_SIZE,
    sortBy: 'part.sku',
    sortDir: 'ASC',
  });
  const all = [...first.data];
  for (let page = 2; page <= first.meta.totalPages; page += 1) {
    const next = await listSpareParts({
      page,
      limit: ALL_PARTS_PAGE_SIZE,
      sortBy: 'part.sku',
      sortDir: 'ASC',
    });
    all.push(...next.data);
  }
  return all;
}

/** GET /spare-parts/:id */
export async function getSparePart(id: string): Promise<SparePart> {
  const data = await request<unknown>(`/spare-parts/${id}`);
  return sparePartSchema.parse(data);
}

export interface CreateSparePartInput {
  sku: string;
  name: string;
  initialQuantity?: number;
  reorderThreshold?: number;
  unitCost: number;
}

/** POST /spare-parts (ADMIN, SUPERVISOR) */
export async function createSparePart(
  input: CreateSparePartInput,
): Promise<SparePart> {
  const data = await request<unknown>('/spare-parts', {
    method: 'POST',
    body: input,
  });
  return sparePartSchema.parse(data);
}

// Restock/adjust both return { sparePart, transaction }
const stockChangeResponseSchema = z.object({
  sparePart: sparePartSchema,
  transaction: z.unknown(),
});

export interface RestockSparePartInput {
  quantity: number;
}

/** POST /spare-parts/:id/restock (ADMIN, SUPERVISOR) */
export async function restockSparePart(
  id: string,
  input: RestockSparePartInput,
): Promise<SparePart> {
  const data = await request<unknown>(`/spare-parts/${id}/restock`, {
    method: 'POST',
    body: input,
  });
  return stockChangeResponseSchema.parse(data).sparePart;
}

export interface AdjustSparePartInput {
  delta: number;
  reason: string;
}

/** POST /spare-parts/:id/adjust (ADMIN, SUPERVISOR) */
export async function adjustSparePart(
  id: string,
  input: AdjustSparePartInput,
): Promise<SparePart> {
  const data = await request<unknown>(`/spare-parts/${id}/adjust`, {
    method: 'POST',
    body: input,
  });
  return stockChangeResponseSchema.parse(data).sparePart;
}

/** DELETE /spare-parts/:id (ADMIN, SUPERVISOR) */
export async function deleteSparePart(id: string): Promise<void> {
  await request<void>(`/spare-parts/${id}`, { method: 'DELETE' });
}

export const inventoryTransactionReasonSchema = z.enum([
  'CONSUMED',
  'RESTOCK',
  'ADJUSTMENT',
]);
export type InventoryTransactionReason = z.infer<
  typeof inventoryTransactionReasonSchema
>;

export const inventoryTransactionSchema = z.object({
  id: z.string(),
  sparePartId: z.string(),
  deltaQuantity: z.number(),
  reason: inventoryTransactionReasonSchema,
  workOrderId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  quantityBefore: z.number(),
  quantityAfter: z.number(),
  createdAt: z.string(),
});
export type InventoryTransaction = z.infer<typeof inventoryTransactionSchema>;

export interface ListSparePartTransactionsParams extends QueryParams {
  page?: number;
  limit?: number;
}

/** GET /spare-parts/:id/transactions (paginated, newest first) */
export async function listSparePartTransactions(
  id: string,
  params: ListSparePartTransactionsParams = {},
) {
  const data = await request<unknown>(`/spare-parts/${id}/transactions`, {
    query: params,
  });
  return paginated(inventoryTransactionSchema).parse(data);
}
