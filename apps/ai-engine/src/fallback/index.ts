import type { ActionType, LlmAnalysisOutput, PaymentBehavior, Priority } from "@aegis/contracts-ai";
import type { CollectedFacts } from "../evidence/facts.js";
import { resolveFacts, type DeterministicSignal } from "../evidence/signals.js";
import type { EvidenceStore } from "../evidence/store.js";
import { T } from "../evidence/thresholds.js";

export interface FallbackDecision {
  type: ActionType;
  priority: Priority;
  reason: string;
  evidenceIds: string[];
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Safe deterministic recommendation used when the model is offline / slow / invalid.
 * It is deliberately conservative: it can only recommend REQUEST_HUMAN_REVIEW, SEND_PAYMENT_REMINDER or NO_ACTION
 * and it never produces (or implies) an AUTO / APPROVAL / BLOCKED decision - Core API still decides.
 */
export function decideFallback(facts: CollectedFacts, signals: DeterministicSignal[], store: EvidenceStore): FallbackDecision {
  const r = resolveFacts(facts);
  const has = (code: DeterministicSignal["code"]): boolean => signals.some((s) => s.code === code);
  const idsOf = (...codes: Array<DeterministicSignal["code"]>): string[] =>
    unique(signals.filter((s) => codes.includes(s.code)).flatMap((s) => s.evidenceIds));
  const days = r.maxOverdueDays?.value ?? 0;

  const anchor = (): string[] => {
    const preferred = [
      facts.invoices?.evidenceIds.openInvoiceCount,
      facts.payments?.evidenceIds.failedCount30d,
      facts.metrics?.evidenceIds.overdueAmount,
      facts.case?.evidenceIds.status,
      facts.case?.evidenceIds.id,
    ].filter((x): x is string => Boolean(x) && store.has(x as string));
    return preferred.length ? [preferred[0] as string] : store.all().slice(0, 1).map((e) => e.evidenceId);
  };
  const explain = (codes: Array<DeterministicSignal["code"]>): string =>
    signals.filter((s) => codes.includes(s.code)).map((s) => s.explanation).join(" ");
  const review = (priority: Priority, codes: Array<DeterministicSignal["code"]>, why: string): FallbackDecision => ({
    type: "REQUEST_HUMAN_REVIEW",
    priority,
    reason: `${explain(codes)} ${why}`.trim(),
    evidenceIds: idsOf(...codes).length ? idsOf(...codes) : anchor(),
  });

  if (!r.hasFinancialData) {
    return {
      type: "REQUEST_HUMAN_REVIEW",
      priority: "MEDIUM",
      reason: "Metrics, invoices and payment history could not be read, so the situation cannot be assessed. A human should review the case.",
      evidenceIds: anchor(),
    };
  }
  if (has("DISPUTED_PAYMENT") || has("DATA_CONFLICT")) {
    return review("HIGH", ["DISPUTED_PAYMENT", "DATA_CONFLICT"], "Disputed or conflicting data requires human review.");
  }
  if (has("ACCOUNT_ON_HOLD")) {
    return review(days >= T.overdue30 ? "HIGH" : "MEDIUM", ["ACCOUNT_ON_HOLD", "OVERDUE_30_DAYS", "HIGH_OUTSTANDING_BALANCE", "REPEATED_PAYMENT_FAILURE"], "The account is already restricted; a human should confirm next steps.");
  }
  if (has("OVERDUE_60_DAYS")) {
    return review(days >= 90 ? "CRITICAL" : "HIGH", ["OVERDUE_60_DAYS", "REPEATED_PAYMENT_FAILURE", "HIGH_OUTSTANDING_BALANCE"], "Severely overdue exposure requires human review.");
  }
  if (has("OVERDUE_30_DAYS") && has("REPEATED_PAYMENT_FAILURE")) {
    return review("HIGH", ["OVERDUE_30_DAYS", "REPEATED_PAYMENT_FAILURE", "HIGH_OUTSTANDING_BALANCE"], "Overdue invoices combined with repeated payment failures require human review.");
  }
  if (has("HIGH_OUTSTANDING_BALANCE")) {
    return review("HIGH", ["HIGH_OUTSTANDING_BALANCE", "OVERDUE_30_DAYS"], "A high overdue balance requires human review.");
  }
  if (has("REPEATED_PAYMENT_FAILURE") || has("REPEATED_PARTIAL_PAYMENT")) {
    return review("MEDIUM", ["REPEATED_PAYMENT_FAILURE", "REPEATED_PARTIAL_PAYMENT", "HIGH_LATE_PAYMENT_RATIO"], "An unusual payment pattern requires human review.");
  }
  if (r.overdueExists) {
    const priority: Priority = days >= 45 ? "HIGH" : days >= 15 ? "MEDIUM" : "LOW";
    const ids = unique([...(r.maxOverdueDays?.ids ?? []), ...(r.overdueAmount?.ids ?? [])]);
    return {
      type: "SEND_PAYMENT_REMINDER",
      priority,
      reason: `${explain(["OVERDUE_30_DAYS", "HIGH_LATE_PAYMENT_RATIO", "NO_RECENT_SUCCESSFUL_PAYMENT"]) || `Overdue exposure exists (oldest invoice ${days} days overdue).`} Risk signals are moderate, so a payment reminder is the proportionate step.`.trim(),
      evidenceIds: ids.length ? ids : anchor(),
    };
  }
  return {
    type: "NO_ACTION",
    priority: "LOW",
    reason: "No overdue exposure, failed payments or disputes were found in the available evidence.",
    evidenceIds: anchor(),
  };
}

export function fallbackBehavior(facts: CollectedFacts, signals: DeterministicSignal[]): PaymentBehavior {
  const r = resolveFacts(facts);
  const has = (c: DeterministicSignal["code"]): boolean => signals.some((s) => s.code === c);
  if (!r.hasFinancialData) return "UNKNOWN";
  if (has("REPEATED_PAYMENT_FAILURE")) return "FAILING";
  if (has("OVERDUE_60_DAYS") || has("HIGH_LATE_PAYMENT_RATIO")) return "HIGHLY_DELAYED";
  if (r.overdueExists) return "DELAYED";
  return "STABLE";
}

const NEXT_STEP: Record<ActionType, string> = {
  REQUEST_HUMAN_REVIEW: "Route the case to a human reviewer together with the cited evidence.",
  SEND_PAYMENT_REMINDER: "Submit the payment reminder proposal to Core API for authorization, policy and risk evaluation.",
  CREATE_COLLECTION_CASE: "Submit the collection case proposal to Core API for authorization, policy and risk evaluation.",
  PLACE_ACCOUNT_HOLD: "Submit the account hold proposal to Core API for authorization, policy and risk evaluation.",
  NO_ACTION: "No action is proposed; keep monitoring the account.",
};

/** Complete deterministic analysis in the same shape as the LLM output. */
export function buildFallbackAnalysis(facts: CollectedFacts, signals: DeterministicSignal[], store: EvidenceStore): LlmAnalysisOutput {
  const d = decideFallback(facts, signals, store);
  const signalText = signals.map((s) => s.explanation).join(" ");
  const summary = `AI model unavailable - deterministic fallback analysis. ${signalText || "No risk signals were detected in the available evidence."}`.slice(0, 1400);
  return {
    summary,
    customerSituation: { segment: facts.customer?.segment ?? "UNKNOWN", paymentBehavior: fallbackBehavior(facts, signals) },
    signals: signals.map((s) => ({ code: s.code, severity: s.severity, evidenceIds: s.evidenceIds, explanation: s.explanation })),
    recommendedAction: { type: d.type, priority: d.priority, reason: d.reason.slice(0, 780), evidenceIds: d.evidenceIds },
    confidence: Math.min(0.5, 0.3 + 0.05 * signals.length),
    uncertainties: ["The AI model was unavailable or its output was rejected; this is a conservative deterministic fallback recommendation."],
    nextBestStep: NEXT_STEP[d.type],
  };
}
