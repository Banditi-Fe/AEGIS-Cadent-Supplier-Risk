import { CORE_API_RESPONSE_SCHEMAS, type ToolName } from "@aegis/contracts-ai";
import { isRec, unwrapArray, unwrapObject, type Rec } from "../evidence/helpers.js";

/**
 * Payload inspection BEFORE the tolerant parsers run. The parsers accept several field-name variants;
 * this step makes sure that a Core API response in an unexpected shape is REPORTED instead of silently
 * producing "no data":
 *   - fatal   -> the tool call is FAILED with INVALID_RESPONSE (nothing recognisable was found)
 *   - notes   -> shown as uncertainties in the analysis (partial loss / contract deviation)
 * Notes only contain field names and counts, never values (values may be customer data).
 */
export interface ShapeReport {
  fatal?: string;
  notes: string[];
}

const has = (rec: Rec, keys: readonly string[]): boolean => keys.some((k) => rec[k] !== undefined && rec[k] !== null);

export const RECOGNISED_KEYS = {
  invoiceAmount: [
    "amountOutstanding", "outstandingAmount", "amountDue", "balanceDue", "balance", "remainingAmount", "openAmount", "outstanding",
    "amountOutstandingCents", "outstandingCents", "amountDueCents", "balanceCents", "amountDueMinor", "amountOutstandingMinor",
    "amount", "total", "totalAmount", "amountTotal", "amountCents", "totalCents", "amountMinor",
  ],
  paymentStatus: ["status", "state", "outcome"],
  caseStatus: ["status", "state", "type", "caseType", "kind", "trigger", "openedAt", "createdAt", "created_at"],
  metrics: [
    "overdueAmount", "amountOverdue", "overdueBalance", "totalOverdue", "overdueAmountCents", "overdueAmountMinor",
    "totalOutstanding", "outstandingAmount", "outstandingBalance", "totalOutstandingAmount", "balance", "totalOutstandingCents", "outstandingCents", "outstandingAmountMinor",
    "maxOverdueDays", "oldestOverdueDays", "maxDaysOverdue", "overdueDays",
    "failedPayments30d", "failedPaymentCount30d", "failedPaymentsLast30Days", "failedPayments", "failedPaymentCount",
    "latePaymentRatio", "latePaymentRate", "lateRatio", "latePaymentPercent", "latePaymentPct",
    "overdueInvoiceCount", "overdueInvoices", "avgDaysToPay", "averageDaysToPay",
  ],
} as const;

const LIST_NAMES: Partial<Record<ToolName, string[]>> = {
  get_open_invoices: ["invoices", "openInvoices"],
  get_payment_history: ["payments", "paymentHistory"],
  get_previous_cases: ["cases", "previousCases"],
};
const OBJECT_NAMES: Partial<Record<ToolName, string[]>> = { get_case: ["case"], get_customer: ["customer"], get_customer_metrics: ["metrics"] };

function recognised(tool: ToolName, rec: Rec): boolean {
  switch (tool) {
    case "get_open_invoices":
      return has(rec, RECOGNISED_KEYS.invoiceAmount);
    case "get_payment_history":
      return has(rec, RECOGNISED_KEYS.paymentStatus);
    case "get_previous_cases":
      return has(rec, RECOGNISED_KEYS.caseStatus);
    case "get_customer_metrics":
      return has(rec, RECOGNISED_KEYS.metrics);
    default:
      return Object.keys(rec).length > 0;
  }
}

export function inspectPayload(tool: ToolName, raw: unknown): ShapeReport {
  const notes: string[] = [];
  const names = LIST_NAMES[tool];

  if (names) {
    const list = unwrapArray(raw, names);
    if (!list) return { fatal: "response is not a list or a { data | items | <name> } envelope", notes };
    if (list.length > 0) {
      const known = list.filter((r) => isRec(r) && recognised(tool, r)).length;
      if (known === 0) return { fatal: `none of the ${list.length} record(s) has a recognisable field set`, notes };
      if (known < list.length) notes.push(`${list.length - known} of ${list.length} ${tool} record(s) had no recognisable fields and were ignored.`);
    }
  } else {
    const obj = unwrapObject(raw, OBJECT_NAMES[tool] ?? []);
    if (!obj) return { fatal: "response is not a JSON object", notes };
    if (!recognised(tool, obj)) return { fatal: "response object has no recognisable fields", notes };
  }

  const check = CORE_API_RESPONSE_SCHEMAS[tool].safeParse(raw);
  if (!check.success) {
    const first = check.error.issues[0];
    const where = first ? first.path.filter((p) => typeof p === "string" || typeof p === "number").join(".") || "(root)" : "(root)";
    notes.push(`${tool} response deviates from the Core API contract (first problem at "${where}"); tolerant parsing was used.`);
  }
  return { notes };
}
