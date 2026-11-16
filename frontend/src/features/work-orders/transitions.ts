import type { WorkOrderStatus } from './api';

export type WorkOrderAction =
  'assign' | 'start' | 'complete' | 'block' | 'cancel';

export const nextActions: Record<WorkOrderStatus, WorkOrderAction[]> = {
  OPEN: ['assign', 'cancel'],
  ASSIGNED: ['start', 'cancel'],
  IN_PROGRESS: ['complete', 'block', 'cancel'],
  BLOCKED: ['start', 'cancel'],
  COMPLETED: [],
  CANCELLED: [],
};

/** The status each action moves a work order to, once it succeeds. */
export const actionTargetStatus: Record<WorkOrderAction, WorkOrderStatus> = {
  assign: 'ASSIGNED',
  start: 'IN_PROGRESS',
  complete: 'COMPLETED',
  block: 'BLOCKED',
  cancel: 'CANCELLED',
};

/** Active-voice button labels, per DESIGN.md's action-bar rule. */
export const actionLabel: Record<WorkOrderAction, string> = {
  assign: 'Assign to me',
  start: 'Start work',
  complete: 'Complete',
  block: 'Block work order',
  cancel: 'Cancel work order',
};
