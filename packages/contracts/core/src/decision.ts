import type {
  ActionType,
  ActorRole,
  AiRecommendation,
  AuthorizationResult,
  Decision,
  DecisionResult,
  PolicyMatch,
  RiskAssessment,
  RiskLevel,
} from './index.js';

export interface DecisionFacts {
  overdueDays: number;
  overdueAmountEur: number;
  failedPaymentCount: number;
  disputedPayment: boolean;
  latePaymentRatio: number;
  /** Set only when the core has verified that required execution data exists. */
  executionDataComplete: boolean;
}

export interface DecisionPolicy {
  id: string;
  name: string;
  priority: number;
  effect: Decision;
  /** The caller/core policy module has already evaluated the rule condition. */
  matched: boolean;
  reason: string;
}

const ROLE_ACTIONS: Record<ActorRole, ReadonlySet<ActionType>> = {
  ADMIN: new Set(['SEND_PAYMENT_REMINDER', 'CREATE_COLLECTION_CASE', 'PLACE_ACCOUNT_HOLD', 'REQUEST_HUMAN_REVIEW']),
  MANAGER: new Set(['SEND_PAYMENT_REMINDER', 'CREATE_COLLECTION_CASE', 'PLACE_ACCOUNT_HOLD', 'REQUEST_HUMAN_REVIEW']),
  OPERATOR: new Set(['SEND_PAYMENT_REMINDER', 'CREATE_COLLECTION_CASE', 'REQUEST_HUMAN_REVIEW']),
  VIEWER: new Set(),
};

export function calculateRisk(facts: DecisionFacts): RiskAssessment {
  const factors: RiskAssessment['factors'] = [];
  const add = (code: string, points: number, detail: string) => factors.push({ code, points, detail });

  if (facts.overdueDays > 0) {
    const points = facts.overdueDays <= 7 ? 5 : facts.overdueDays <= 30 ? 15 : facts.overdueDays <= 60 ? 25 : facts.overdueDays <= 90 ? 35 : 45;
    add('OVERDUE_AGE', points, `${facts.overdueDays} days overdue`);
  }
  if (facts.failedPaymentCount > 0) {
    const points = facts.failedPaymentCount === 1 ? 10 : facts.failedPaymentCount === 2 ? 20 : 30;
    add('FAILED_PAYMENTS', points, `${facts.failedPaymentCount} failed payment(s)`);
  }
  if (facts.disputedPayment) add('DISPUTED_PAYMENT', 35, 'A payment is disputed');
  if (facts.overdueAmountEur >= 5000) add('HIGH_OVERDUE_AMOUNT', 20, 'Overdue balance is at least EUR 5,000');
  else if (facts.overdueAmountEur >= 1000) add('HIGH_OVERDUE_AMOUNT', 10, 'Overdue balance is at least EUR 1,000');
  if (facts.latePaymentRatio >= 0.75) add('LATE_PAYMENT_RATIO', 30, 'At least 75% of payments were late');
  else if (facts.latePaymentRatio >= 0.5) add('LATE_PAYMENT_RATIO', 20, 'At least 50% of payments were late');
  else if (facts.latePaymentRatio >= 0.25) add('LATE_PAYMENT_RATIO', 10, 'At least 25% of payments were late');

  const score = Math.min(100, factors.reduce((total, factor) => total + factor.points, 0));
  const level: RiskLevel = score >= 80 ? 'CRITICAL' : score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
  return { score, level, factors, calculatedAt: new Date().toISOString(), engineVersion: '1.0.0' };
}

export function decideAction(input: {
  actionType: ActionType;
  role: ActorRole;
  recommendation: AiRecommendation | null;
  facts: DecisionFacts;
  policies: DecisionPolicy[];
  autoConfidenceThreshold?: number;
  autoRiskThreshold?: number;
}): DecisionResult {
  const validFacts = [input.facts.overdueDays, input.facts.overdueAmountEur, input.facts.failedPaymentCount, input.facts.latePaymentRatio]
    .every(Number.isFinite) && input.facts.overdueDays >= 0 && input.facts.overdueAmountEur >= 0 &&
    input.facts.failedPaymentCount >= 0 && input.facts.latePaymentRatio >= 0 && input.facts.latePaymentRatio <= 1;
  const risk: RiskAssessment = validFacts
    ? calculateRisk(input.facts)
    : { score: 100, level: 'CRITICAL', factors: [{ code: 'INVALID_FACTS', points: 100, detail: 'Decision facts failed validation' }], calculatedAt: new Date().toISOString(), engineVersion: '1.0.0' };
  const allowed = ROLE_ACTIONS[input.role]?.has(input.actionType) ?? false;
  const authorization: AuthorizationResult = {
    allowed,
    role: input.role,
    actionType: input.actionType,
    permission: `${input.role}:${input.actionType}`,
    reason: allowed ? `${input.role} may request this action` : `${input.role} may not perform this action`,
  };
  const matchedPolicies: PolicyMatch[] = input.policies
    .filter((policy) => policy.matched)
    .sort((a, b) => b.priority - a.priority)
    .map(({ id, name, effect, reason, priority }) => ({ policyId: id, name, effect, reason, priority }));
  const confidence = input.recommendation?.confidence ?? null;
  const finish = (decision: Decision, reason: string): DecisionResult => ({
    decision, reason, authorization, risk, matchedPolicies, aiConfidence: confidence,
  });

  if (!allowed) return finish('BLOCKED', authorization.reason);
  if (!validFacts) return finish('BLOCKED', 'Decision facts are invalid; fail-closed handling blocked the action.');
  const blockingPolicy = matchedPolicies.find((policy) => policy.effect === 'BLOCKED');
  if (blockingPolicy) return finish('BLOCKED', `Policy "${blockingPolicy.name}" blocks this action: ${blockingPolicy.reason}`);
  const approvalPolicy = matchedPolicies.find((policy) => policy.effect === 'APPROVAL');
  if (risk.level === 'CRITICAL') {
    return approvalPolicy
      ? finish('APPROVAL', `Critical risk requires human review. ${approvalPolicy.reason}`)
      : finish('BLOCKED', 'Critical risk blocks autonomous execution without an explicit approval policy.');
  }
  if (!input.facts.executionDataComplete) return finish('BLOCKED', 'Required execution data is missing.');
  if (
    !input.recommendation ||
    input.recommendation.recommendedAction !== input.actionType ||
    !Number.isFinite(input.recommendation.confidence) ||
    input.recommendation.confidence < 0 ||
    input.recommendation.confidence > 1
  ) {
    return finish('APPROVAL', 'A valid matching AI recommendation is unavailable; autonomous execution is disabled.');
  }
  if (approvalPolicy) return finish('APPROVAL', `Policy "${approvalPolicy.name}" requires approval: ${approvalPolicy.reason}`);
  if (input.actionType === 'PLACE_ACCOUNT_HOLD') return finish('APPROVAL', 'Account holds always require human approval.');
  const automaticPolicy = matchedPolicies.find((policy) => policy.effect === 'AUTO');
  if (!automaticPolicy) return finish('APPROVAL', 'No matched policy explicitly permits autonomous execution.');
  const threshold = input.autoConfidenceThreshold ?? 0.85;
  if (input.recommendation.confidence < threshold) return finish('APPROVAL', `AI confidence ${input.recommendation.confidence.toFixed(2)} is below the autonomous threshold ${threshold.toFixed(2)}.`);
  const riskThreshold = input.autoRiskThreshold ?? 60;
  if (risk.score >= riskThreshold) return finish('APPROVAL', `Risk score ${risk.score} meets or exceeds the autonomous threshold ${riskThreshold}.`);
  return finish('AUTO', 'Authorization passed, required data is present, no blocking or approval policy matched, and risk and confidence are within autonomous limits.');
}
