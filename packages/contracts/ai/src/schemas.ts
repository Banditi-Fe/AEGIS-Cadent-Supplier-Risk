import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Constants shared by AI Engine, Core API and the web app             */
/* ------------------------------------------------------------------ */
export const AI_SCHEMA_VERSION = "1.0" as const;
export const SERVICE_KEY_HEADER = "x-service-key" as const;

export const ACTION_TYPES = [
  "SEND_PAYMENT_REMINDER",
  "CREATE_COLLECTION_CASE",
  "PLACE_ACCOUNT_HOLD",
  "REQUEST_HUMAN_REVIEW",
  "NO_ACTION",
] as const;
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const PAYMENT_BEHAVIORS = ["STABLE", "DELAYED", "HIGHLY_DELAYED", "FAILING", "UNKNOWN"] as const;
export const TOOL_NAMES = [
  "get_case",
  "get_customer",
  "get_customer_metrics",
  "get_open_invoices",
  "get_payment_history",
  "get_previous_cases",
] as const;
export const SIGNAL_CODES = [
  "OVERDUE_30_DAYS",
  "OVERDUE_60_DAYS",
  "HIGH_OUTSTANDING_BALANCE",
  "REPEATED_PAYMENT_FAILURE",
  "HIGH_LATE_PAYMENT_RATIO",
  "DISPUTED_PAYMENT",
  "NO_RECENT_SUCCESSFUL_PAYMENT",
  "REPEATED_PARTIAL_PAYMENT",
  "ACCOUNT_ON_HOLD",
  "DATA_CONFLICT",
] as const;
export const EVIDENCE_SOURCE_TYPES = [
  "case",
  "customer",
  "metrics",
  "invoice",
  "invoice_summary",
  "payment",
  "payment_summary",
  "previous_case",
  "previous_case_summary",
] as const;
export const ANALYSIS_STATUSES = ["COMPLETED", "DEGRADED"] as const;
export const DEGRADED_REASONS = [
  "LLM_UNAVAILABLE",
  "LLM_TIMEOUT",
  "LLM_OVERLOADED",
  "LLM_MALFORMED_OUTPUT",
  "LLM_INVALID_OUTPUT",
  "PARTIAL_EVIDENCE",
] as const;
export const MODEL_STATUSES = ["COMPLETED", "TIMEOUT", "UNAVAILABLE", "OVERLOADED", "INVALID_OUTPUT"] as const;
export const TRACE_TYPES = ["TOOL", "REASONING", "LLM", "VALIDATION"] as const;
export const TRACE_STATUSES = ["SUCCESS", "FAILED", "SKIPPED"] as const;
export const TRACE_PHASES = [
  "INITIALIZE",
  "PLAN",
  "COLLECT",
  "NORMALIZE",
  "SIGNAL_DETECTION",
  "LLM_ANALYSIS",
  "EVIDENCE_VALIDATION",
  "RECOMMEND",
  "CONFIDENCE",
  "RETURN",
] as const;

/** The AI Engine never produces these as an authority decision. Core API owns them. */
export const CORE_API_DECISIONS = ["AUTO", "APPROVAL", "BLOCKED"] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type PaymentBehavior = (typeof PAYMENT_BEHAVIORS)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
export type SignalCode = (typeof SIGNAL_CODES)[number];
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** Read-only Core API internal endpoints consumed by the AI Engine (Core API is the source of truth). */
const enc = encodeURIComponent;
export const CORE_API_ENDPOINTS = {
  case: (caseId: string) => `/internal/v1/cases/${enc(caseId)}`,
  customer: (customerId: string) => `/internal/v1/customers/${enc(customerId)}`,
  customerMetrics: (customerId: string) => `/internal/v1/customers/${enc(customerId)}/metrics`,
  customerInvoices: (customerId: string) => `/internal/v1/customers/${enc(customerId)}/invoices`,
  customerPayments: (customerId: string) => `/internal/v1/customers/${enc(customerId)}/payments`,
  customerCases: (customerId: string) => `/internal/v1/customers/${enc(customerId)}/cases`,
} as const;

export const AI_ENGINE_ROUTES = {
  health: "/health",
  ready: "/ready",
  analyzeCase: "/v1/analyze/case",
} as const;

/* ------------------------------------------------------------------ */
/* Primitive schemas                                                   */
/* ------------------------------------------------------------------ */
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export const PrioritySchema = z.enum(PRIORITIES);
export const SeveritySchema = z.enum(SEVERITIES);
export const PaymentBehaviorSchema = z.enum(PAYMENT_BEHAVIORS);
export const ToolNameSchema = z.enum(TOOL_NAMES);
export const EvidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);
export const DegradedReasonSchema = z.enum(DEGRADED_REASONS);

/** Identifier safe to embed in URLs and evidence IDs (no path/whitespace/control characters). */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, "invalid identifier");

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */
export const RequestedBySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("USER"), userId: IdentifierSchema }),
  z.object({ type: z.literal("SYSTEM"), userId: IdentifierSchema.optional() }),
]);

export const AnalyzeCaseRequestSchema = z.object({
  organizationId: IdentifierSchema,
  caseId: IdentifierSchema,
  customerId: IdentifierSchema,
  requestedBy: RequestedBySchema,
});
export type AnalyzeCaseRequest = z.infer<typeof AnalyzeCaseRequestSchema>;

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */
export const EvidenceRecordSchema = z
  .object({
    evidenceId: z.string().min(1).max(200),
    sourceType: EvidenceSourceTypeSchema,
    sourceId: z.string().min(1).max(200),
    field: z.string().min(1).max(100),
    value: z.union([z.string().max(300), z.number(), z.boolean(), z.null()]),
    observedAt: z.string().min(1),
  })
  .strict();
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/* ------------------------------------------------------------------ */
/* Required LLM output (strict)                                        */
/* ------------------------------------------------------------------ */
export const LlmAnalysisOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(1500),
    customerSituation: z
      .object({
        segment: z.string().trim().min(1).max(100),
        paymentBehavior: PaymentBehaviorSchema,
      })
      .strict(),
    signals: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(64),
            severity: SeveritySchema,
            evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
            explanation: z.string().trim().min(1).max(600),
          })
          .strict(),
      )
      .max(20),
    recommendedAction: z
      .object({
        type: ActionTypeSchema,
        priority: PrioritySchema,
        reason: z.string().trim().min(1).max(800),
        evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    uncertainties: z.array(z.string().trim().min(1).max(500)).max(20),
    nextBestStep: z.string().trim().min(1).max(500),
  })
  .strict();
export type LlmAnalysisOutput = z.infer<typeof LlmAnalysisOutputSchema>;

/* ------------------------------------------------------------------ */
/* Tool result + agent trace                                           */
/* ------------------------------------------------------------------ */
export const ToolResultSchema = z.object({
  tool: ToolNameSchema,
  status: z.enum(["SUCCESS", "FAILED", "SKIPPED"]),
  durationMs: z.number().min(0),
  recordCount: z.number().int().min(0),
  evidence: z.array(EvidenceRecordSchema),
});
export type ToolResultSummary = z.infer<typeof ToolResultSchema>;

export const TraceStepSchema = z
  .object({
    step: z.number().int().min(1),
    phase: z.enum(TRACE_PHASES),
    name: z.string().min(1).max(120),
    type: z.enum(TRACE_TYPES),
    status: z.enum(TRACE_STATUSES),
    startedAt: z.string().min(1),
    durationMs: z.number().min(0),
    tool: ToolNameSchema.optional(),
    recordCount: z.number().int().min(0).optional(),
    httpStatus: z.number().int().optional(),
    errorCode: z.string().max(64).optional(),
    attempt: z.number().int().min(1).optional(),
    detail: z.string().max(500).optional(),
    /** Only on TOOL steps: every evidence record this tool call produced (contract section 7). */
    evidence: z.array(EvidenceRecordSchema).optional(),
  })
  .strict();
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const ModelMetadataSchema = z.object({
  provider: z.string().min(1),
  /** Canonical model name (section 25 of the contract). */
  name: z.string().min(1),
  /** Alias of `name` (section 22 of the contract). */
  model: z.string().min(1),
  latencyMs: z.number().int().min(0),
  attempt: z.number().int().min(0),
  status: z.enum(MODEL_STATUSES),
});
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */
export const AnalyzeCaseResponseSchema = z.object({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  agentRunId: z.string().min(1),
  caseId: z.string().min(1),
  organizationId: z.string().min(1),
  customerId: z.string().min(1),
  status: z.enum(ANALYSIS_STATUSES),
  degradedReasons: z.array(DegradedReasonSchema),
  summary: LlmAnalysisOutputSchema.shape.summary,
  customerSituation: LlmAnalysisOutputSchema.shape.customerSituation,
  signals: LlmAnalysisOutputSchema.shape.signals,
  recommendedAction: LlmAnalysisOutputSchema.shape.recommendedAction,
  confidence: z.number().min(0).max(1),
  uncertainties: z.array(z.string()),
  nextBestStep: z.string().min(1),
  /** Evidence records cited by signals / recommendedAction (the AI Engine never reports facts without evidence). */
  evidence: z.array(EvidenceRecordSchema),
  toolTrace: z.array(TraceStepSchema),
  model: ModelMetadataSchema,
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
});
export type AnalyzeCaseResponse = z.infer<typeof AnalyzeCaseResponseSchema>;

export const ANALYSIS_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "CASE_NOT_FOUND",
  "CASE_SCOPE_MISMATCH",
  "CORE_API_UNAUTHORIZED",
  "CORE_API_UNAVAILABLE",
  "CASE_DATA_INVALID",
  "SERVICE_BUSY",
  "ANALYSIS_TIMEOUT",
  "NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export const AnalyzeCaseErrorSchema = z.object({
  schemaVersion: z.literal(AI_SCHEMA_VERSION).optional(),
  status: z.literal("FAILED").optional(),
  agentRunId: z.string().optional(),
  caseId: z.string().optional(),
  error: z.object({
    code: z.enum(ANALYSIS_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  toolTrace: z.array(TraceStepSchema).optional(),
});
export type AnalyzeCaseError = z.infer<typeof AnalyzeCaseErrorSchema>;
