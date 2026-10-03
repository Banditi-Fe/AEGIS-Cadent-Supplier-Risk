import type { ActionType, Decision } from './index.js';

export type PolicyOperator = 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'NOT_IN';
export type PolicyCondition =
  | { field: string; operator: PolicyOperator; value: string | number | boolean | null | Array<string | number | boolean> }
  | { all: PolicyCondition[] }
  | { any: PolicyCondition[] };

export interface PolicyDefinition {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  actionType?: ActionType;
  effect: Decision;
  conditions: PolicyCondition;
  reason: string;
}

export interface PolicyEvaluation {
  finalEffect: Decision;
  reason: string;
  matchedPolicies: Array<Pick<PolicyDefinition, 'id' | 'name' | 'priority' | 'effect' | 'reason'>>;
  unmatchedRelevantPolicies: Array<Pick<PolicyDefinition, 'id' | 'name' | 'priority' | 'effect'>>;
}

type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function evaluateCondition(condition: PolicyCondition, context: Record<string, unknown>): boolean {
  if ('all' in condition) return condition.all.length > 0 && condition.all.every((child) => evaluateCondition(child, context));
  if ('any' in condition) return condition.any.length > 0 && condition.any.some((child) => evaluateCondition(child, context));

  if (!(condition.field in context)) return false;
  const actual = context[condition.field];
  const expected = condition.value;
  if (condition.operator === 'IN' || condition.operator === 'NOT_IN') {
    if (!Array.isArray(expected) || !isScalar(actual)) return false;
    const included = expected.some((candidate) => candidate === actual);
    return condition.operator === 'IN' ? included : !included;
  }
  if (!isScalar(actual) || !isScalar(expected)) return false;
  switch (condition.operator) {
    case 'EQ': return actual === expected;
    case 'NEQ': return actual !== expected;
    case 'GT': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'GTE': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'LT': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'LTE': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
  }
}

/**
 * Evaluates Core API-owned policy rules. Context must be constructed from
 * trusted Core API records, never directly from a browser or AI payload.
 */
export function evaluatePolicies(input: {
  actionType: ActionType;
  policies: PolicyDefinition[];
  context: Record<string, unknown>;
}): PolicyEvaluation {
  const relevant = input.policies
    .filter((policy) => policy.enabled && (!policy.actionType || policy.actionType === input.actionType))
    .sort((left, right) => right.priority - left.priority);

  let unmatchedRelevantPolicies: PolicyEvaluation['unmatchedRelevantPolicies'];
  let matchedPolicies: PolicyEvaluation['matchedPolicies'];
  try {
    matchedPolicies = relevant.filter((policy) => evaluateCondition(policy.conditions, input.context));
    unmatchedRelevantPolicies = relevant
      .filter((policy) => !matchedPolicies.some((match) => match.id === policy.id))
      .map(({ id, name, priority, effect }) => ({ id, name, priority, effect }));
  } catch {
    return {
      finalEffect: 'BLOCKED',
      reason: 'Policy evaluation failed; the action is blocked.',
      matchedPolicies: [],
      unmatchedRelevantPolicies: relevant.map(({ id, name, priority, effect }) => ({ id, name, priority, effect })),
    };
  }

  const blocked = matchedPolicies.find((policy) => policy.effect === 'BLOCKED');
  if (blocked) return { finalEffect: 'BLOCKED', reason: blocked.reason, matchedPolicies, unmatchedRelevantPolicies };
  const approval = matchedPolicies.find((policy) => policy.effect === 'APPROVAL');
  if (approval) return { finalEffect: 'APPROVAL', reason: approval.reason, matchedPolicies, unmatchedRelevantPolicies };
  const automatic = matchedPolicies.find((policy) => policy.effect === 'AUTO');
  if (automatic) return { finalEffect: 'AUTO', reason: automatic.reason, matchedPolicies, unmatchedRelevantPolicies };

  return {
    finalEffect: 'APPROVAL',
    reason: 'No enabled policy explicitly permits autonomous execution; human approval is required.',
    matchedPolicies,
    unmatchedRelevantPolicies,
  };
}
