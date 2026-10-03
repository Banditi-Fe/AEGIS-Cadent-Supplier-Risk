import { CORE_API_ENDPOINTS, type ToolName } from "@aegis/contracts-ai";
import { EvidenceBuilder } from "../evidence/store.js";
import type {
  CaseFact,
  CustomerFact,
  InvoiceFact,
  InvoicesFact,
  MetricsFact,
  PaymentFact,
  PaymentStatus,
  PaymentsFact,
  PreviousCasesFact,
} from "../evidence/facts.js";
import {
  daysBetween,
  isRec,
  isoDate,
  pickBool,
  pickDate,
  pickMoney,
  pickNum,
  pickStr,
  round2,
  unwrapArray,
  unwrapObject,
  upper,
  type Rec,
} from "../evidence/helpers.js";
import { T } from "../evidence/thresholds.js";
import { ToolDataError, type ParseContext, type ReadOnlyTool, type ToolParseResult } from "./types.js";

const CLOSED_STATUSES = new Set(["CLOSED", "RESOLVED", "DONE", "COMPLETED", "CANCELLED", "CANCELED", "DISMISSED"]);
const HOLD_STATUSES = new Set(["ON_HOLD", "HOLD", "HELD", "SUSPENDED", "BLOCKED", "FROZEN", "RESTRICTED"]);
const PAID_INVOICE = new Set(["PAID", "SETTLED", "VOID", "VOIDED", "CANCELLED", "CANCELED", "WRITTEN_OFF", "REFUNDED"]);
const OK_PAYMENT = new Set(["SUCCEEDED", "SUCCESS", "SUCCESSFUL", "PAID", "COMPLETED", "SETTLED", "CAPTURED"]);
const FAILED_PAYMENT = new Set(["FAILED", "FAILURE", "DECLINED", "REJECTED", "ERROR", "BOUNCED"]);
const DISPUTED_PAYMENT = new Set(["DISPUTED", "CHARGEBACK", "CHARGED_BACK", "IN_DISPUTE"]);
const PARTIAL_PAYMENT = new Set(["PARTIAL", "PARTIALLY_PAID", "PARTIAL_PAYMENT"]);
const PENDING_PAYMENT = new Set(["PENDING", "PROCESSING", "INITIATED", "AUTHORIZED"]);

const norm = (s: string | undefined): string | undefined => s?.toUpperCase().replace(/[\s-]+/g, "_");

export function mapPaymentStatus(raw: string | undefined): PaymentStatus {
  const s = norm(raw);
  if (!s) return "UNKNOWN";
  if (OK_PAYMENT.has(s)) return "SUCCEEDED";
  if (FAILED_PAYMENT.has(s)) return "FAILED";
  if (DISPUTED_PAYMENT.has(s)) return "DISPUTED";
  if (PARTIAL_PAYMENT.has(s)) return "PARTIAL";
  if (PENDING_PAYMENT.has(s)) return "PENDING";
  if (s === "REFUNDED") return "REFUNDED";
  return "UNKNOWN";
}

function compactIds(ids: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids)) if (v) out[k] = v;
  return out;
}

function finish(b: EvidenceBuilder, recordCount: number, facts: ToolParseResult["facts"], notes?: string[]): ToolParseResult {
  return {
    evidence: b.records,
    untrustedIds: [...b.untrusted],
    flaggedTextCount: b.flaggedTextCount,
    recordCount,
    facts,
    notes,
  };
}

/* ------------------------------------------------------------------ get_case */
const getCase: ReadOnlyTool = {
  name: "get_case",
  description: "Load the case under investigation (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.case(ctx.caseId),
  parse(raw, ctx) {
    const rec = unwrapObject(raw, ["case"]);
    if (!rec) throw new ToolDataError("INVALID_RESPONSE", "case payload is not an object");
    const id = pickStr(rec, "id", "caseId") ?? ctx.caseId;
    const ref = pickStr(rec, "number", "reference", "caseNumber") ?? id;
    const b = new EvidenceBuilder(ctx.observedAt);
    const status = upper(pickStr(rec, "status", "state"));
    const opened = pickDate(rec, "openedAt", "createdAt", "created_at");
    const evidenceIds = compactIds({
      id: b.add("case", ref, id, "id", id),
      status: b.add("case", ref, id, "status", status),
      type: b.add("case", ref, id, "type", upper(pickStr(rec, "type", "caseType", "kind", "trigger"))),
      openedAt: b.add("case", ref, id, "openedAt", opened ? isoDate(opened) : undefined),
      reason: b.addText("case", ref, id, "reason", pickStr(rec, "reason", "notes", "description", "summary")),
    });
    const fact: CaseFact = {
      id,
      ref,
      customerId: pickStr(rec, "customerId", "customer_id") ?? (isRec(rec.customer) ? pickStr(rec.customer, "id") : undefined),
      organizationId: pickStr(rec, "organizationId", "organization_id", "orgId", "tenantId"),
      status,
      closed: status !== undefined && CLOSED_STATUSES.has(status),
      evidenceIds,
    };
    return finish(b, 1, { case: fact });
  },
};

/* -------------------------------------------------------------- get_customer */
const getCustomer: ReadOnlyTool = {
  name: "get_customer",
  description: "Load the customer profile (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.customer(ctx.customerId),
  parse(raw, ctx) {
    const rec = unwrapObject(raw, ["customer"]);
    if (!rec) throw new ToolDataError("INVALID_RESPONSE", "customer payload is not an object");
    const id = pickStr(rec, "id", "customerId") ?? ctx.customerId;
    const b = new EvidenceBuilder(ctx.observedAt);
    const status = upper(pickStr(rec, "status", "state", "accountStatus"));
    const created = pickDate(rec, "createdAt", "created_at", "customerSince");
    const segment = pickStr(rec, "segment", "tier", "customerSegment", "type");
    const evidenceIds = compactIds({
      name: b.addText("customer", id, id, "name", pickStr(rec, "name", "displayName", "companyName"), 120),
      segment: b.add("customer", id, id, "segment", segment),
      status: b.add("customer", id, id, "status", status),
      riskTier: b.add("customer", id, id, "riskTier", upper(pickStr(rec, "riskTier", "riskLevel", "riskRating"))),
      createdAt: b.add("customer", id, id, "createdAt", created ? isoDate(created) : undefined),
      notes: b.addText("customer", id, id, "notes", pickStr(rec, "notes", "note", "comment", "description")),
    });
    const onHold = (status !== undefined && HOLD_STATUSES.has(status)) || pickBool(rec, "onHold", "accountHold", "isOnHold", "hold") === true;
    const fact: CustomerFact = {
      id,
      organizationId: pickStr(rec, "organizationId", "organization_id", "orgId", "tenantId"),
      segment,
      status,
      onHold,
      evidenceIds,
    };
    return finish(b, 1, { customer: fact });
  },
};

/* ------------------------------------------------------ get_customer_metrics */
const getCustomerMetrics: ReadOnlyTool = {
  name: "get_customer_metrics",
  description: "Load Core-computed payment metrics for the customer (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.customerMetrics(ctx.customerId),
  parse(raw, ctx) {
    const rec = unwrapObject(raw, ["metrics"]);
    if (!rec) throw new ToolDataError("INVALID_RESPONSE", "metrics payload is not an object");
    const cid = ctx.customerId;
    const b = new EvidenceBuilder(ctx.observedAt);

    const overdueAmount = pickMoney(rec, ["overdueAmount", "amountOverdue", "overdueBalance", "totalOverdue"], ["overdueAmountCents", "overdueAmountMinor"]);
    const totalOutstanding = pickMoney(
      rec,
      ["totalOutstanding", "outstandingAmount", "outstandingBalance", "totalOutstandingAmount", "balance"],
      ["totalOutstandingCents", "outstandingCents", "outstandingAmountMinor"],
    );
    const maxOverdueDays = pickNum(rec, "maxOverdueDays", "oldestOverdueDays", "maxDaysOverdue", "overdueDays");
    const failed = pickNum(rec, "failedPayments30d", "failedPaymentCount30d", "failedPaymentsLast30Days", "failedPayments", "failedPaymentCount");
    let ratio = pickNum(rec, "latePaymentRatio", "latePaymentRate", "lateRatio");
    if (ratio === undefined) {
      const pct = pickNum(rec, "latePaymentPercent", "latePaymentPct");
      if (pct !== undefined) ratio = pct / 100;
    }
    if (ratio !== undefined && (ratio < 0 || ratio > 1)) ratio = undefined; // ambiguous scale -> do not guess
    const overdueInvoiceCount = pickNum(rec, "overdueInvoiceCount", "overdueInvoices");
    const avgDaysToPay = pickNum(rec, "avgDaysToPay", "averageDaysToPay");
    const currency = pickStr(rec, "currency");

    const evidenceIds = compactIds({
      totalOutstanding: b.add("metrics", cid, cid, "totalOutstanding", totalOutstanding),
      overdueAmount: b.add("metrics", cid, cid, "overdueAmount", overdueAmount),
      overdueInvoiceCount: b.add("metrics", cid, cid, "overdueInvoiceCount", overdueInvoiceCount),
      maxOverdueDays: b.add("metrics", cid, cid, "maxOverdueDays", maxOverdueDays),
      failedPayments30d: b.add("metrics", cid, cid, "failedPayments30d", failed),
      latePaymentRatio: b.add("metrics", cid, cid, "latePaymentRatio", ratio !== undefined ? round2(ratio * 100) / 100 : undefined),
      avgDaysToPay: b.add("metrics", cid, cid, "avgDaysToPay", avgDaysToPay),
      currency: b.add("metrics", cid, cid, "currency", currency),
    });
    const fact: MetricsFact = {
      overdueAmount,
      totalOutstanding,
      maxOverdueDays,
      failedPayments30d: failed,
      latePaymentRatio: ratio !== undefined ? round2(ratio * 100) / 100 : undefined,
      overdueInvoiceCount,
      currency,
      evidenceIds,
    };
    return finish(b, 1, { metrics: fact });
  },
};

/* --------------------------------------------------------- get_open_invoices */
const getOpenInvoices: ReadOnlyTool = {
  name: "get_open_invoices",
  description: "Load open invoices of the customer (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.customerInvoices(ctx.customerId),
  parse(raw, ctx) {
    const list = unwrapArray(raw, ["invoices", "openInvoices"]);
    if (!list) throw new ToolDataError("INVALID_RESPONSE", "invoices payload is not a list");
    const cid = ctx.customerId;
    const notes: string[] = [];
    const b = new EvidenceBuilder(ctx.observedAt);
    const entries = list.slice(0, T.maxRecords);
    if (list.length > T.maxRecords) notes.push(`Invoice list truncated to ${T.maxRecords} of ${list.length} records.`);

    interface Draft { fact: InvoiceFact; description?: string }
    const drafts: Draft[] = [];
    const currencies = new Set<string>();
    let skipped = 0;

    entries.forEach((entry, idx) => {
      if (!isRec(entry)) {
        skipped += 1;
        return;
      }
      const rec: Rec = entry;
      const id = pickStr(rec, "id", "invoiceId") ?? `unknown_${idx + 1}`;
      const ref = pickStr(rec, "number", "invoiceNumber", "reference", "code") ?? id;
      const status = norm(pickStr(rec, "status", "state"));
      const total = pickMoney(rec, ["amount", "total", "totalAmount", "amountTotal"], ["amountCents", "totalCents", "amountMinor"]);
      const paid = pickMoney(rec, ["amountPaid", "paidAmount"], ["amountPaidCents", "paidCents"]);
      let outstanding = pickMoney(
        rec,
        ["amountOutstanding", "outstandingAmount", "amountDue", "balanceDue", "balance", "remainingAmount", "openAmount", "outstanding"],
        ["amountOutstandingCents", "outstandingCents", "amountDueCents", "balanceCents", "amountDueMinor", "amountOutstandingMinor"],
      );
      if (outstanding === undefined && total !== undefined) outstanding = round2(Math.max(0, total - (paid ?? 0)));
      if ((status && PAID_INVOICE.has(status)) || outstanding === undefined || outstanding <= 0) {
        skipped += 1;
        return;
      }
      const due = pickDate(rec, "dueAt", "dueDate", "due_date");
      const overdueDays = due ? Math.max(0, daysBetween(ctx.now, due)) : 0;
      const currency = pickStr(rec, "currency");
      if (currency) currencies.add(currency);
      drafts.push({
        fact: {
          id,
          ref,
          amountOutstanding: outstanding,
          currency,
          dueAt: due ? isoDate(due) : undefined,
          overdueDays,
          disputed: status === "DISPUTED" || pickBool(rec, "disputed", "isDisputed") === true,
          evidenceIds: {},
        },
        description: pickStr(rec, "description", "notes", "memo", "reference_text"),
      });
    });
    if (skipped > 0) notes.push(`${skipped} non-open or unreadable invoice record(s) were ignored.`);

    drafts.sort((a, c) => c.fact.overdueDays - a.fact.overdueDays || c.fact.amountOutstanding - a.fact.amountOutstanding);
    drafts.forEach((d, i) => {
      if (i >= T.maxInvoicesEvidence) return;
      const f = d.fact;
      f.evidenceIds = compactIds({
        dueAt: b.add("invoice", f.ref, f.id, "dueAt", f.dueAt),
        amountOutstanding: b.add("invoice", f.ref, f.id, "amountOutstanding", f.amountOutstanding),
        status: b.add("invoice", f.ref, f.id, "status", f.disputed ? "DISPUTED" : "OPEN"),
        overdueDays: b.add("invoice", f.ref, f.id, "overdueDays", f.dueAt ? f.overdueDays : undefined),
        description: i < 3 ? b.addText("invoice", f.ref, f.id, "description", d.description) : undefined,
      });
    });

    const items = drafts.map((d) => d.fact);
    const overdue = items.filter((i) => i.overdueDays >= 1);
    const overdueAmount = round2(overdue.reduce((s, i) => s + i.amountOutstanding, 0));
    const totalOutstanding = round2(items.reduce((s, i) => s + i.amountOutstanding, 0));
    const maxOverdueDays = items.reduce((m, i) => Math.max(m, i.overdueDays), 0);
    const currency = currencies.size === 1 ? [...currencies][0] : undefined;

    const evidenceIds = compactIds({
      openInvoiceCount: b.add("invoice_summary", cid, cid, "openInvoiceCount", items.length),
      overdueInvoiceCount: b.add("invoice_summary", cid, cid, "overdueInvoiceCount", overdue.length),
      overdueAmount: b.add("invoice_summary", cid, cid, "overdueAmount", overdueAmount),
      totalOutstanding: b.add("invoice_summary", cid, cid, "totalOutstanding", totalOutstanding),
      maxOverdueDays: b.add("invoice_summary", cid, cid, "maxOverdueDays", maxOverdueDays),
      currency: b.add("invoice_summary", cid, cid, "currency", currency),
    });
    const fact: InvoicesFact = {
      items,
      openCount: items.length,
      overdueCount: overdue.length,
      overdueAmount,
      totalOutstanding,
      maxOverdueDays,
      currency,
      truncated: list.length > T.maxRecords,
      evidenceIds,
    };
    return finish(b, list.length, { invoices: fact }, notes);
  },
};

/* ------------------------------------------------------- get_payment_history */
const getPaymentHistory: ReadOnlyTool = {
  name: "get_payment_history",
  description: "Load recent payment attempts of the customer (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.customerPayments(ctx.customerId),
  parse(raw, ctx) {
    const list = unwrapArray(raw, ["payments", "paymentHistory"]);
    if (!list) throw new ToolDataError("INVALID_RESPONSE", "payments payload is not a list");
    const cid = ctx.customerId;
    const notes: string[] = [];
    const b = new EvidenceBuilder(ctx.observedAt);
    const entries = list.slice(0, T.maxRecords);
    if (list.length > T.maxRecords) notes.push(`Payment list truncated to ${T.maxRecords} of ${list.length} records.`);

    interface Draft { fact: PaymentFact; at?: Date; reason?: string }
    const drafts: Draft[] = [];
    let unreadable = 0;
    entries.forEach((entry, idx) => {
      if (!isRec(entry)) {
        unreadable += 1;
        return;
      }
      const rec: Rec = entry;
      const id = pickStr(rec, "id", "paymentId") ?? `unknown_${idx + 1}`;
      const ref = pickStr(rec, "number", "reference") ?? id;
      let status = mapPaymentStatus(pickStr(rec, "status", "state", "outcome"));
      if (pickBool(rec, "disputed", "isDisputed") === true) status = "DISPUTED";
      const at = pickDate(rec, "attemptedAt", "paidAt", "processedAt", "occurredAt", "createdAt", "date");
      const daysLate = pickNum(rec, "daysLate", "lateDays", "latenessDays");
      const lateFlag = pickBool(rec, "late", "isLate", "paidLate");
      const late = lateFlag ?? (daysLate !== undefined ? daysLate > 0 : undefined);
      drafts.push({
        fact: {
          id,
          ref,
          status,
          at: at ? isoDate(at) : undefined,
          amount: pickMoney(rec, ["amount", "total", "amountPaid"], ["amountCents", "amountMinor"]),
          late,
          evidenceIds: {},
        },
        at,
        reason: pickStr(rec, "failureReason", "failureCode", "declineReason", "errorMessage", "note"),
      });
    });
    if (unreadable > 0) notes.push(`${unreadable} unreadable payment record(s) were ignored.`);

    drafts.sort((a, c) => (c.at?.getTime() ?? -Infinity) - (a.at?.getTime() ?? -Infinity));
    drafts.forEach((d, i) => {
      if (i >= T.maxPaymentsEvidence) return;
      const f = d.fact;
      f.evidenceIds = compactIds({
        status: b.add("payment", f.ref, f.id, "status", f.status),
        attemptedAt: b.add("payment", f.ref, f.id, "attemptedAt", f.at),
        amount: b.add("payment", f.ref, f.id, "amount", f.amount),
        failureReason: f.status === "FAILED" ? b.addText("payment", f.ref, f.id, "failureReason", d.reason, 120) : undefined,
      });
    });

    const within = (d: Draft, days: number): boolean => {
      if (!d.at) return false;
      const age = daysBetween(ctx.now, d.at);
      return age >= 0 && age <= days;
    };
    const items = drafts.map((d) => d.fact);
    const failed30d = drafts.filter((d) => d.fact.status === "FAILED" && within(d, T.failureWindowDays)).length;
    const disputed180d = drafts.filter((d) => d.fact.status === "DISPUTED" && (within(d, T.disputeWindowDays) || !d.at)).length;
    const partial90d = drafts.filter((d) => d.fact.status === "PARTIAL" && within(d, T.partialWindowDays)).length;
    const successful = drafts.filter((d) => d.fact.status === "SUCCEEDED" || d.fact.status === "PARTIAL");
    const successful60d = successful.filter((d) => within(d, T.noRecentPaymentDays)).length;
    const lastSuccess = successful.map((d) => d.at).filter((x): x is Date => x !== undefined).sort((a, c) => c.getTime() - a.getTime())[0];
    const lateSamples = drafts.filter((d) => d.fact.status === "SUCCEEDED" && d.fact.late !== undefined);
    const lateCount = lateSamples.filter((d) => d.fact.late === true).length;
    const lateRatio = lateSamples.length >= T.lateMinSamples ? round2(lateCount / lateSamples.length) : undefined;

    const evidenceIds = compactIds({
      paymentRecordCount: b.add("payment_summary", cid, cid, "paymentRecordCount", list.length),
      failedCount30d: b.add("payment_summary", cid, cid, "failedCount30d", failed30d),
      successfulCount60d: b.add("payment_summary", cid, cid, "successfulCount60d", successful60d),
      lastSuccessfulPaymentAt: b.add("payment_summary", cid, cid, "lastSuccessfulPaymentAt", lastSuccess ? isoDate(lastSuccess) : null),
      disputedCount180d: b.add("payment_summary", cid, cid, "disputedCount180d", disputed180d),
      partialCount90d: b.add("payment_summary", cid, cid, "partialCount90d", partial90d),
      latePaymentRatio: b.add("payment_summary", cid, cid, "latePaymentRatio", lateRatio),
      lateSampleCount: b.add("payment_summary", cid, cid, "lateSampleCount", lateSamples.length),
    });
    const fact: PaymentsFact = {
      items,
      failed30d,
      disputed180d,
      partial90d,
      successful60d,
      lastSuccessfulAt: lastSuccess ? isoDate(lastSuccess) : null,
      lateRatio,
      lateSamples: lateSamples.length,
      evidenceIds,
    };
    return finish(b, list.length, { payments: fact }, notes);
  },
};

/* -------------------------------------------------------- get_previous_cases */
const getPreviousCases: ReadOnlyTool = {
  name: "get_previous_cases",
  description: "Load earlier cases of the customer (read-only).",
  path: (ctx) => CORE_API_ENDPOINTS.customerCases(ctx.customerId),
  parse(raw, ctx) {
    const list = unwrapArray(raw, ["cases", "previousCases"]);
    if (!list) throw new ToolDataError("INVALID_RESPONSE", "cases payload is not a list");
    const cid = ctx.customerId;
    const b = new EvidenceBuilder(ctx.observedAt);

    interface Draft { id: string; ref: string; status?: string; type?: string; opened?: Date; outcome?: string }
    const drafts: Draft[] = [];
    list.slice(0, T.maxRecords).forEach((entry, idx) => {
      if (!isRec(entry)) return;
      const rec: Rec = entry;
      const id = pickStr(rec, "id", "caseId") ?? `unknown_${idx + 1}`;
      if (id === ctx.caseId) return; // the case under investigation is not "previous"
      drafts.push({
        id,
        ref: pickStr(rec, "number", "reference", "caseNumber") ?? id,
        status: upper(pickStr(rec, "status", "state")),
        type: upper(pickStr(rec, "type", "caseType", "kind", "trigger")),
        opened: pickDate(rec, "openedAt", "createdAt", "created_at"),
        outcome: pickStr(rec, "outcome", "resolution", "result"),
      });
    });
    drafts.sort((a, c) => (c.opened?.getTime() ?? -Infinity) - (a.opened?.getTime() ?? -Infinity));
    const openCount = drafts.filter((d) => !(d.status && CLOSED_STATUSES.has(d.status))).length;
    const last = drafts[0];

    drafts.slice(0, T.maxCasesEvidence).forEach((d) => {
      b.add("previous_case", d.ref, d.id, "status", d.status);
      b.add("previous_case", d.ref, d.id, "type", d.type);
      b.add("previous_case", d.ref, d.id, "openedAt", d.opened ? isoDate(d.opened) : undefined);
      b.addText("previous_case", d.ref, d.id, "outcome", d.outcome, 120);
    });
    const evidenceIds = compactIds({
      count: b.add("previous_case_summary", cid, cid, "count", drafts.length),
      openCount: b.add("previous_case_summary", cid, cid, "openCount", openCount),
      lastOpenedAt: b.add("previous_case_summary", cid, cid, "lastOpenedAt", last?.opened ? isoDate(last.opened) : null),
      lastOutcome: last ? b.addText("previous_case_summary", cid, cid, "lastOutcome", last.outcome, 120) : undefined,
    });
    const fact: PreviousCasesFact = { count: drafts.length, openCount, evidenceIds };
    return finish(b, list.length, { previousCases: fact });
  },
};

export const TOOLS: Record<ToolName, ReadOnlyTool> = {
  get_case: getCase,
  get_customer: getCustomer,
  get_customer_metrics: getCustomerMetrics,
  get_open_invoices: getOpenInvoices,
  get_payment_history: getPaymentHistory,
  get_previous_cases: getPreviousCases,
};

export type { ParseContext };
