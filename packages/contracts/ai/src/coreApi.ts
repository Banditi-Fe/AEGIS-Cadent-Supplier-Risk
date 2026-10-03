import { z } from "zod";
import type { ToolName } from "./schemas.js";

/**
 * Response contract of the Core API read-only endpoints (/internal/v1/*) as the AI Engine consumes them.
 *
 * - The CANONICAL field names below are what Backend A should send.
 * - The AI Engine parsers additionally tolerate the documented aliases (see apps/ai-engine/src/tools/shapes.ts),
 *   but every payload is checked against these schemas first so that a different shape is REPORTED
 *   (uncertainty / INVALID_RESPONSE) instead of silently losing data.
 * - Schemas are loose (unknown fields allowed): Core API may add fields without breaking the AI Engine.
 * - Money is a number in major units (e.g. 1200.5). Minor units must be sent as `*Cents`.
 * - Dates are ISO-8601 strings.
 */
const money = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
const isoDateLike = z.union([z.string().min(1), z.number()]);

export const CoreApiCaseSchema = z.looseObject({
  id: z.string().min(1),
  number: z.string().optional(),
  customerId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  openedAt: isoDateLike.optional(),
  reason: z.string().nullable().optional(),
});

export const CoreApiCustomerSchema = z.looseObject({
  id: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  name: z.string().optional(),
  segment: z.string().nullable().optional(),
  status: z.string().optional(),
  riskTier: z.string().nullable().optional(),
  createdAt: isoDateLike.optional(),
});

export const CoreApiMetricsSchema = z.looseObject({
  overdueAmount: money.optional(),
  totalOutstanding: money.optional(),
  maxOverdueDays: z.number().optional(),
  failedPayments30d: z.number().optional(),
  latePaymentRatio: z.number().min(0).max(1).optional(),
  overdueInvoiceCount: z.number().optional(),
  currency: z.string().optional(),
});

export const CoreApiInvoiceSchema = z.looseObject({
  id: z.string().min(1),
  number: z.string().optional(),
  amount: money.optional(),
  amountOutstanding: money.optional(),
  status: z.string().optional(),
  dueDate: isoDateLike.optional(),
  currency: z.string().optional(),
});

export const CoreApiPaymentSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  amount: money.optional(),
  attemptedAt: isoDateLike.optional(),
});

export const CoreApiPreviousCaseSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  openedAt: isoDateLike.optional(),
  outcome: z.string().nullable().optional(),
});

/** A list endpoint answers with a bare array or an envelope `{ data | items | <name> : [...] }`. */
export const listOf = <T extends z.ZodType>(item: T, name: string) =>
  z.union([z.array(item), z.looseObject({ [name]: z.array(item) }), z.looseObject({ data: z.array(item) }), z.looseObject({ items: z.array(item) })]);

export const CORE_API_RESPONSE_SCHEMAS: Record<ToolName, z.ZodType> = {
  get_case: z.union([CoreApiCaseSchema, z.looseObject({ data: CoreApiCaseSchema }), z.looseObject({ case: CoreApiCaseSchema })]),
  get_customer: z.union([CoreApiCustomerSchema, z.looseObject({ data: CoreApiCustomerSchema }), z.looseObject({ customer: CoreApiCustomerSchema })]),
  get_customer_metrics: z.union([CoreApiMetricsSchema, z.looseObject({ data: CoreApiMetricsSchema }), z.looseObject({ metrics: CoreApiMetricsSchema })]),
  get_open_invoices: listOf(CoreApiInvoiceSchema, "invoices"),
  get_payment_history: listOf(CoreApiPaymentSchema, "payments"),
  get_previous_cases: listOf(CoreApiPreviousCaseSchema, "cases"),
};
