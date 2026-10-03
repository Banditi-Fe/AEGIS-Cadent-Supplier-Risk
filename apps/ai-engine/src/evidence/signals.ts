import type { Severity, SignalCode } from "@aegis/contracts-ai";
import type { CollectedFacts, InvoiceFact } from "./facts.js";
import { T } from "./thresholds.js";

/** A signal computed by code from collected facts. The LLM may explain it but never invent or alter it. */
export interface DeterministicSignal {
  code: SignalCode;
  severity: Severity;
  evidenceIds: string[];
  explanation: string;
}

export const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
export const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

const ids = (...xs: Array<string | undefined>): string[] => xs.filter((x): x is string => Boolean(x));
const dedupe = (xs: string[]): string[] => [...new Set(xs)];
export const fmtMoney = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export interface Resolved<V> {
  value: V;
  ids: string[];
  source: "invoices" | "payments" | "metrics";
}

export interface ResolvedFacts {
  maxOverdueDays?: Resolved<number> & { worst?: InvoiceFact };
  overdueAmount?: Resolved<number> & { count?: number };
  failed30d?: Resolved<number>;
  lateRatio?: Resolved<number>;
  currency?: string;
  /** true when at least one of metrics / invoices / payments could be read */
  hasFinancialData: boolean;
  overdueExists: boolean;
}

/** Picks the best available source per fact (raw invoices/payments first, Core metrics as fallback). */
export function resolveFacts(f: CollectedFacts): ResolvedFacts {
  const out: ResolvedFacts = { hasFinancialData: false, overdueExists: false };
  const invOk = f.toolStatus.get_open_invoices === "SUCCESS" && f.invoices;
  const payOk = f.toolStatus.get_payment_history === "SUCCESS" && f.payments;
  const metOk = f.toolStatus.get_customer_metrics === "SUCCESS" && f.metrics;
  out.hasFinancialData = Boolean(invOk || payOk || metOk);

  if (invOk && f.invoices) {
    const inv = f.invoices;
    const worst = inv.items[0];
    out.maxOverdueDays = {
      value: inv.maxOverdueDays,
      source: "invoices",
      worst,
      ids: ids(worst?.evidenceIds.dueAt, worst?.evidenceIds.overdueDays, inv.evidenceIds.maxOverdueDays),
    };
    out.overdueAmount = {
      value: inv.overdueAmount,
      source: "invoices",
      count: inv.overdueCount,
      ids: ids(inv.evidenceIds.overdueAmount, inv.evidenceIds.overdueInvoiceCount),
    };
    out.currency = inv.currency;
  } else if (metOk && f.metrics) {
    const m = f.metrics;
    if (m.maxOverdueDays !== undefined) {
      out.maxOverdueDays = { value: m.maxOverdueDays, source: "metrics", ids: ids(m.evidenceIds.maxOverdueDays) };
    }
    if (m.overdueAmount !== undefined) {
      out.overdueAmount = { value: m.overdueAmount, source: "metrics", ids: ids(m.evidenceIds.overdueAmount) };
    }
    out.currency = m.currency;
  }

  if (payOk && f.payments) {
    const p = f.payments;
    const failedIds = p.items
      .filter((i) => i.status === "FAILED" && i.at)
      .slice(0, 3)
      .map((i) => i.evidenceIds.status);
    out.failed30d = { value: p.failed30d, source: "payments", ids: ids(p.evidenceIds.failedCount30d, ...failedIds) };
  } else if (metOk && f.metrics?.failedPayments30d !== undefined) {
    out.failed30d = { value: f.metrics.failedPayments30d, source: "metrics", ids: ids(f.metrics.evidenceIds.failedPayments30d) };
  }

  if (metOk && f.metrics?.latePaymentRatio !== undefined) {
    out.lateRatio = { value: f.metrics.latePaymentRatio, source: "metrics", ids: ids(f.metrics.evidenceIds.latePaymentRatio) };
  } else if (payOk && f.payments?.lateRatio !== undefined) {
    out.lateRatio = { value: f.payments.lateRatio, source: "payments", ids: ids(f.payments.evidenceIds.latePaymentRatio, f.payments.evidenceIds.lateSampleCount) };
  }

  const days = out.maxOverdueDays?.value ?? 0;
  const amount = out.overdueAmount?.value ?? 0;
  out.overdueExists = days >= 1 || amount > 0;
  return out;
}

/** Deterministic signal extraction. Same input -> same output; no model involved. */
export function detectSignals(f: CollectedFacts): DeterministicSignal[] {
  const r = resolveFacts(f);
  const out: DeterministicSignal[] = [];
  const cur = r.currency ? ` ${r.currency}` : "";
  const fallbackIds = ids(f.invoices?.evidenceIds.openInvoiceCount, f.payments?.evidenceIds.paymentRecordCount, f.case?.evidenceIds.id);
  const push = (code: SignalCode, severity: Severity, evidenceIds: string[], explanation: string): void => {
    const chosen = dedupe(evidenceIds.length ? evidenceIds : fallbackIds);
    out.push({ code, severity, evidenceIds: chosen, explanation });
  };

  // --- overdue age -------------------------------------------------------
  const od = r.maxOverdueDays;
  if (od && od.value >= T.overdue30) {
    const text = od.worst
      ? `Invoice ${od.worst.ref} is ${od.value} days overdue${od.worst.dueAt ? ` (due ${od.worst.dueAt})` : ""}.`
      : `The oldest overdue invoice is ${od.value} days overdue according to customer metrics.`;
    push("OVERDUE_30_DAYS", "MEDIUM", od.ids, text);
    if (od.value >= T.overdue60) push("OVERDUE_60_DAYS", od.value >= 90 ? "CRITICAL" : "HIGH", od.ids, text);
  }

  // --- exposure ----------------------------------------------------------
  const oa = r.overdueAmount;
  if (oa && oa.value >= T.highOutstanding) {
    const count = oa.count !== undefined ? ` across ${oa.count} overdue invoice${oa.count === 1 ? "" : "s"}` : "";
    push(
      "HIGH_OUTSTANDING_BALANCE",
      oa.value >= T.veryHighOutstanding ? "CRITICAL" : "HIGH",
      oa.ids,
      `Overdue balance is ${fmtMoney(oa.value)}${cur}${count}.`,
    );
  }

  // --- failed payments ---------------------------------------------------
  const fp = r.failed30d;
  if (fp && fp.value >= T.repeatedFailures) {
    push("REPEATED_PAYMENT_FAILURE", fp.value >= 3 ? "HIGH" : "MEDIUM", fp.ids, `${fp.value} failed payments in the last ${T.failureWindowDays} days.`);
  }

  // --- late payment ratio ------------------------------------------------
  const lr = r.lateRatio;
  if (lr && lr.value > T.lateRatio) {
    push(
      "HIGH_LATE_PAYMENT_RATIO",
      lr.value > 0.8 ? "HIGH" : "MEDIUM",
      lr.ids,
      `${Math.round(lr.value * 100)}% of the customer's payments were late (late payment ratio ${lr.value}).`,
    );
  }

  // --- payment history based --------------------------------------------
  const pay = f.toolStatus.get_payment_history === "SUCCESS" ? f.payments : undefined;
  if (pay) {
    if (pay.disputed180d >= 1) {
      const disputedIds = pay.items.filter((i) => i.status === "DISPUTED").slice(0, 3).map((i) => i.evidenceIds.status);
      push(
        "DISPUTED_PAYMENT",
        "HIGH",
        ids(pay.evidenceIds.disputedCount180d, ...disputedIds),
        `${pay.disputed180d} payment${pay.disputed180d === 1 ? " is" : "s are"} in dispute.`,
      );
    }
    if (r.overdueExists && (r.overdueAmount?.value ?? 0) > 0 && pay.successful60d === 0) {
      push(
        "NO_RECENT_SUCCESSFUL_PAYMENT",
        "MEDIUM",
        ids(pay.evidenceIds.successfulCount60d, pay.evidenceIds.lastSuccessfulPaymentAt),
        pay.lastSuccessfulAt
          ? `No successful payment in the last ${T.noRecentPaymentDays} days (last successful payment ${pay.lastSuccessfulAt}).`
          : `No successful payment in the last ${T.noRecentPaymentDays} days and none on record.`,
      );
    }
    if (pay.partial90d >= T.partialCount) {
      push("REPEATED_PARTIAL_PAYMENT", "MEDIUM", ids(pay.evidenceIds.partialCount90d), `${pay.partial90d} partial payments in the last ${T.partialWindowDays} days.`);
    }
  }

  // --- account state -----------------------------------------------------
  if (f.toolStatus.get_customer === "SUCCESS" && f.customer?.onHold) {
    push("ACCOUNT_ON_HOLD", "HIGH", ids(f.customer.evidenceIds.status), `Customer account status is ${f.customer.status ?? "ON_HOLD"}.`);
  }

  // --- conflicting sources ----------------------------------------------
  if (f.toolStatus.get_open_invoices === "SUCCESS" && f.invoices && f.toolStatus.get_customer_metrics === "SUCCESS" && f.metrics?.overdueAmount !== undefined) {
    const a = f.metrics.overdueAmount;
    const b = f.invoices.overdueAmount;
    const diff = Math.abs(a - b);
    if (diff > Math.max(T.conflictAbsTolerance, T.conflictRelTolerance * Math.max(a, b))) {
      push(
        "DATA_CONFLICT",
        "HIGH",
        ids(f.metrics.evidenceIds.overdueAmount, f.invoices.evidenceIds.overdueAmount),
        `Customer metrics report an overdue amount of ${fmtMoney(a)} but the open invoices sum to ${fmtMoney(b)}.`,
      );
    }
  }
  return out;
}
