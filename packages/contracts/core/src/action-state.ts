import type { ActionStatus, Decision } from './index.js';

const TRANSITIONS: Record<ActionStatus, ReadonlySet<ActionStatus>> = {
  PROPOSED: new Set(['APPROVAL_REQUIRED', 'APPROVED', 'BLOCKED', 'CANCELLED']),
  APPROVAL_REQUIRED: new Set(['APPROVED', 'REJECTED', 'BLOCKED', 'CANCELLED']),
  APPROVED: new Set(['EXECUTING', 'CANCELLED', 'BLOCKED']),
  REJECTED: new Set(),
  EXECUTING: new Set(['EXECUTED', 'FAILED']),
  EXECUTED: new Set(),
  FAILED: new Set(),
  BLOCKED: new Set(),
  CANCELLED: new Set(),
};

export function initialActionStatus(decision: Decision): ActionStatus {
  if (decision === 'AUTO') return 'APPROVED';
  if (decision === 'APPROVAL') return 'APPROVAL_REQUIRED';
  return 'BLOCKED';
}

export function canTransitionAction(current: ActionStatus, next: ActionStatus): boolean {
  return TRANSITIONS[current]?.has(next) ?? false;
}

export function transitionAction(current: ActionStatus, next: ActionStatus): ActionStatus {
  if (!canTransitionAction(current, next)) {
    throw new Error(`Invalid action state transition: ${current} -> ${next}`);
  }
  return next;
}
