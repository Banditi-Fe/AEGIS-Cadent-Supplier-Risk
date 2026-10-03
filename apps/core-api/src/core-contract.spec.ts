import { describe, expect, it } from 'vitest';
import {
  calculateRisk,
  calculateCustomerMetrics,
  computeAuditEventHash,
  decideAction,
  evaluatePolicies,
  canTransitionAction,
  initialActionStatus,
  verifyAuditChain,
  type AiRecommendation,
  type DecisionFacts,
} from '../../../packages/contracts/core/src/index.js';

const facts: DecisionFacts = {
  overdueDays: 45,
  overdueAmountEur: 1800,
  failedPaymentCount: 2,
  disputedPayment: false,
  latePaymentRatio: 0.1,
  executionDataComplete: true,
};

const recommendation: AiRecommendation = {
  provider: 'ollama',
  model: 'local-model',
  caseId: 'case-1',
  recommendedAction: 'SEND_PAYMENT_REMINDER',
  confidence: 0.95,
  summary: 'Send a payment reminder for the overdue invoice.',
  signals: ['invoice overdue'],
  uncertainties: [],
};

describe('shared Core API decision contract', () => {
  it('calculates deterministic risk from verified facts', () => {
    const risk = calculateRisk(facts);
    expect(risk.score).toBe(55);
    expect(risk.level).toBe('MEDIUM');
  });

  it('calculates payment metrics with integer minor-unit arithmetic', () => {
    const metrics = calculateCustomerMetrics({
      now: new Date('2026-10-03T00:00:00.000Z'),
      invoices: [
        { amountMinor: 180000, paidAmountMinor: 0, issuedAt: '2026-07-01', dueAt: '2026-08-19', status: 'OVERDUE' },
        { amountMinor: 10000, paidAmountMinor: 10000, issuedAt: '2026-08-01', dueAt: '2026-09-01', paidAt: '2026-09-11', status: 'PAID' },
      ],
      payments: [
        { amountMinor: 10000, paidAt: '2026-09-11', status: 'SUCCESS' },
        { amountMinor: 5000, status: 'FAILED' },
      ],
    });
    expect(metrics.totalInvoiced).toBe('1900.00');
    expect(metrics.totalPaid).toBe('100.00');
    expect(metrics.overdueOutstanding).toBe('1800.00');
    expect(metrics.averagePaymentDelayDays).toBe(10);
    expect(metrics.paymentSuccessRate).toBe(0.5);
  });

  it('hashes audit metadata canonically and detects tampering', async () => {
    const common = { organizationId: 'org-1', actorType: 'SYSTEM' as const, eventType: 'CASE_CREATED', entityType: 'Case', entityId: 'case-1', correlationId: 'request-1' };
    const createdAt = '2026-10-03T00:00:00.000Z';
    const metadata = { reason: 'overdue', risk: { score: 55, level: 'MEDIUM' } };
    const eventHash = await computeAuditEventHash({ eventType: common.eventType, entityType: common.entityType, entityId: common.entityId, createdAt, metadata });
    const first = { ...common, id: 'audit-1', createdAt, metadata, eventHash, previousHash: null };
    expect(await verifyAuditChain([first])).toEqual({ valid: true, checkedEvents: 1, brokenAt: null });
    const altered = { ...first, metadata: { ...metadata, reason: 'edited' } };
    expect(await verifyAuditChain([altered])).toEqual({ valid: false, checkedEvents: 1, brokenAt: 'audit-1' });
  });

  it('maps decisions into guarded action states', () => {
    expect(initialActionStatus('AUTO')).toBe('APPROVED');
    expect(initialActionStatus('APPROVAL')).toBe('APPROVAL_REQUIRED');
    expect(initialActionStatus('BLOCKED')).toBe('BLOCKED');
    expect(canTransitionAction('APPROVAL_REQUIRED', 'APPROVED')).toBe(true);
    expect(canTransitionAction('EXECUTED', 'EXECUTING')).toBe(false);
    expect(canTransitionAction('APPROVAL_REQUIRED', 'EXECUTED')).toBe(false);
  });

  it('evaluates policy conditions and requires approval when none match', () => {
    const policy = {
      id: 'policy-reminder',
      name: 'Low risk reminder',
      enabled: true,
      priority: 10,
      actionType: 'SEND_PAYMENT_REMINDER' as const,
      effect: 'AUTO' as const,
      conditions: {
        all: [
          { field: 'actionType', operator: 'EQ' as const, value: 'SEND_PAYMENT_REMINDER' },
          { field: 'riskScore', operator: 'LT' as const, value: 60 },
        ],
      },
      reason: 'Reminder is below the risk limit.',
    };
    const matched = evaluatePolicies({ actionType: 'SEND_PAYMENT_REMINDER', policies: [policy], context: { actionType: 'SEND_PAYMENT_REMINDER', riskScore: 55 } });
    expect(matched.finalEffect).toBe('AUTO');
    expect(matched.matchedPolicies).toHaveLength(1);

    const unmatched = evaluatePolicies({ actionType: 'SEND_PAYMENT_REMINDER', policies: [policy], context: { actionType: 'SEND_PAYMENT_REMINDER', riskScore: 75 } });
    expect(unmatched.finalEffect).toBe('APPROVAL');
    expect(unmatched.unmatchedRelevantPolicies).toHaveLength(1);
  });

  it('returns AUTO only with authorization, complete facts, valid AI evidence, and a matched AUTO policy', () => {
    const result = decideAction({
      actionType: 'SEND_PAYMENT_REMINDER',
      role: 'OPERATOR',
      recommendation,
      facts,
      policies: [{ id: 'p1', name: 'Reminder policy', priority: 1, effect: 'AUTO', matched: true, reason: 'Within limits.' }],
    });
    expect(result.decision).toBe('AUTO');
    expect(result.risk.score).toBe(55);
  });

  it('fails closed when authorization is denied or decision facts are invalid', () => {
    expect(decideAction({ actionType: 'SEND_PAYMENT_REMINDER', role: 'VIEWER', recommendation, facts, policies: [] }).decision).toBe('BLOCKED');
    expect(decideAction({ actionType: 'SEND_PAYMENT_REMINDER', role: 'OPERATOR', recommendation, facts: { ...facts, overdueDays: Number.NaN }, policies: [] }).decision).toBe('BLOCKED');
  });

  it('does not auto-execute when AI evidence is missing, risk is critical, or no AUTO policy matches', () => {
    const base = { actionType: 'SEND_PAYMENT_REMINDER' as const, role: 'OPERATOR' as const, facts, policies: [] };
    expect(decideAction({ ...base, recommendation: null }).decision).toBe('APPROVAL');
    expect(decideAction({ ...base, recommendation, facts: { ...facts, disputedPayment: true, failedPaymentCount: 3 } }).decision).toBe('BLOCKED');
    expect(decideAction({ ...base, recommendation }).decision).toBe('APPROVAL');
  });
});
