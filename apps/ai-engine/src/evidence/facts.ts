import type { ToolName } from "@aegis/contracts-ai";

export type ToolDataStatus = "SUCCESS" | "FAILED" | "MISSING";

export interface CaseFact {
  id: string;
  ref: string;
  customerId?: string;
  organizationId?: string;
  status?: string;
  closed: boolean;
  evidenceIds: Record<string, string>;
}

export interface CustomerFact {
  id: string;
  organizationId?: string;
  segment?: string;
  status?: string;
  onHold: boolean;
  evidenceIds: Record<string, string>;
}

export interface MetricsFact {
  overdueAmount?: number;
  totalOutstanding?: number;
  maxOverdueDays?: number;
  failedPayments30d?: number;
  latePaymentRatio?: number;
  overdueInvoiceCount?: number;
  currency?: string;
  evidenceIds: Record<string, string>;
}

export interface InvoiceFact {
  id: string;
  ref: string;
  amountOutstanding: number;
  currency?: string;
  dueAt?: string;
  overdueDays: number;
  disputed: boolean;
  /** evidence ids emitted for this invoice (only the most relevant invoices get evidence) */
  evidenceIds: Record<string, string>;
}

export interface InvoicesFact {
  items: InvoiceFact[];
  openCount: number;
  overdueCount: number;
  overdueAmount: number;
  totalOutstanding: number;
  maxOverdueDays: number;
  currency?: string;
  truncated: boolean;
  evidenceIds: Record<string, string>;
}

export type PaymentStatus = "SUCCEEDED" | "FAILED" | "DISPUTED" | "PARTIAL" | "PENDING" | "REFUNDED" | "UNKNOWN";

export interface PaymentFact {
  id: string;
  ref: string;
  status: PaymentStatus;
  at?: string;
  amount?: number;
  late?: boolean;
  evidenceIds: Record<string, string>;
}

export interface PaymentsFact {
  items: PaymentFact[];
  failed30d: number;
  disputed180d: number;
  partial90d: number;
  successful60d: number;
  lastSuccessfulAt: string | null;
  lateRatio?: number;
  lateSamples: number;
  evidenceIds: Record<string, string>;
}

export interface PreviousCasesFact {
  count: number;
  openCount: number;
  evidenceIds: Record<string, string>;
}

export interface CollectedFacts {
  case?: CaseFact;
  customer?: CustomerFact;
  metrics?: MetricsFact;
  invoices?: InvoicesFact;
  payments?: PaymentsFact;
  previousCases?: PreviousCasesFact;
  toolStatus: Record<ToolName, ToolDataStatus>;
  notes: string[];
}

export function emptyFacts(): CollectedFacts {
  return {
    toolStatus: {
      get_case: "MISSING",
      get_customer: "MISSING",
      get_customer_metrics: "MISSING",
      get_open_invoices: "MISSING",
      get_payment_history: "MISSING",
      get_previous_cases: "MISSING",
    },
    notes: [],
  };
}
