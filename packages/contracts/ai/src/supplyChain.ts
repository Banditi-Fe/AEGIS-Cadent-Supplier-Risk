import { z } from "zod";

export const SUPPLY_RISK_CATEGORIES = [
  "FINANCIAL",
  "OPERATIONAL",
  "BUSINESS_CONTINUITY",
  "CYBER",
  "ESG",
  "COMPLIANCE",
  "GEOPOLITICAL",
  "REPUTATIONAL",
] as const;
export const SUPPLY_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"] as const;
export const RECOVERY_OPTION_TYPES = ["TRANSFER_STOCK", "EXPEDITE_SUPPLY", "APPROVED_ALTERNATE", "RESCHEDULE_WORK", "MONITOR"] as const;
export const RECOVERY_DECISIONS = ["AUTO", "APPROVAL", "BLOCKED"] as const;
export const SUPPLY_AGENT_ROUTES = { analyzeDisruption: "/v1/analyze/disruption" } as const;

export const SupplyRiskCategorySchema = z.enum(SUPPLY_RISK_CATEGORIES);
export const SupplyRiskLevelSchema = z.enum(SUPPLY_RISK_LEVELS);
export const RecoveryOptionTypeSchema = z.enum(RECOVERY_OPTION_TYPES);
export const RecoveryDecisionSchema = z.enum(RECOVERY_DECISIONS);

export const SupplyEvidenceSchema = z.object({
  evidenceId: z.string().min(1).max(180),
  source: z.string().min(1).max(80),
  sourceRecordId: z.string().min(1).max(180),
  field: z.string().min(1).max(100),
  value: z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
  observedAt: z.string().datetime(),
  freshness: z.enum(["CURRENT", "STALE", "UNKNOWN"]),
});
export type SupplyEvidence = z.infer<typeof SupplyEvidenceSchema>;

export const SupplyRiskSignalSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  category: SupplyRiskCategorySchema,
  level: SupplyRiskLevelSchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(600),
  source: z.string().min(1).max(120),
  observedAt: z.string().datetime(),
  evidenceIds: z.array(z.string().min(1)).min(1),
});
export type SupplyRiskSignal = z.infer<typeof SupplyRiskSignalSchema>;

export const SupplierNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(180),
  tier: z.number().int().min(1).max(10),
  status: z.enum(["ACTIVE", "AT_RISK", "SUSPENDED", "UNKNOWN"]),
  criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  parentSupplierIds: z.array(z.string()),
  aribaSupplierId: z.string().optional(),
});

export const FacilityImpactSchema = z.object({
  facilityId: z.string(),
  facilityName: z.string(),
  serviceArea: z.string(),
  itemId: z.string(),
  itemName: z.string(),
  availableUnits: z.number().int().min(0),
  dailyDemand: z.number().int().positive(),
  daysOfCover: z.number().min(0),
  shortageAt: z.string().datetime().nullable(),
  delayDays: z.number().int().positive(),
  uncoveredDays: z.number().min(0),
  shortageUnits: z.number().int().min(0),
  serviceCriticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  evidenceIds: z.array(z.string()),
});
export type FacilityImpact = z.infer<typeof FacilityImpactSchema>;

export const RecoveryOptionSchema = z.object({
  id: z.string().min(1),
  type: RecoveryOptionTypeSchema,
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(700),
  feasible: z.boolean(),
  estimatedCost: z.number().min(0),
  currency: z.string().length(3),
  arrivesInDays: z.number().min(0),
  quantityUnits: z.number().int().min(0),
  shortageDaysCovered: z.number().min(0),
  residualShortageUnits: z.number().int().min(0),
  constraints: z.array(z.string().max(240)),
  requiresApproval: z.boolean(),
  evidenceIds: z.array(z.string()),
});
export type RecoveryOption = z.infer<typeof RecoveryOptionSchema>;

export const DisruptionContextSchema = z.object({
  organizationId: z.string(),
  demoData: z.boolean(),
  disruption: z.object({
    id: z.string(),
    supplierId: z.string(),
    supplierName: z.string(),
    affectedSupplierIds: z.array(z.string()),
    itemId: z.string(),
    itemName: z.string(),
    delayDays: z.number().int().positive(),
    reportedAt: z.string().datetime(),
    sourceMessage: z.string().max(1000),
    status: z.enum(["OPEN", "ASSESSED", "RESOLVED"]),
  }),
  supplierNetwork: z.array(SupplierNodeSchema),
  riskSignals: z.array(SupplyRiskSignalSchema),
  impacts: z.array(FacilityImpactSchema),
  options: z.array(RecoveryOptionSchema),
  evidence: z.array(SupplyEvidenceSchema),
  dataWarnings: z.array(z.string().max(300)),
});
export type DisruptionContext = z.infer<typeof DisruptionContextSchema>;

/** Model output is advisory. It can choose only a deterministic option ID supplied by Core API. */
export const SupplyLlmOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  recommendedOptionId: z.string().min(1).nullable(),
  rationale: z.string().trim().min(1).max(800),
  citedEvidenceIds: z.array(z.string().min(1)).max(20),
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(12),
  confidence: z.number().min(0).max(1),
}).strict();
export type SupplyLlmOutput = z.infer<typeof SupplyLlmOutputSchema>;

export const AnalyzeDisruptionRequestSchema = z.object({
  organizationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/),
  disruptionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/),
}).strict();
export type AnalyzeDisruptionRequest = z.infer<typeof AnalyzeDisruptionRequestSchema>;

export const AnalyzeDisruptionResponseSchema = z.object({
  schemaVersion: z.literal("1.0"),
  agentRunId: z.string(),
  organizationId: z.string(),
  disruptionId: z.string(),
  status: z.enum(["COMPLETED", "DEGRADED"]),
  summary: z.string(),
  riskLevel: SupplyRiskLevelSchema,
  impacts: z.array(FacilityImpactSchema),
  options: z.array(RecoveryOptionSchema),
  recommendation: z.object({
    optionId: z.string().nullable(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
    citedEvidenceIds: z.array(z.string()),
  }),
  uncertainties: z.array(z.string()),
  evidence: z.array(SupplyEvidenceSchema),
  toolTrace: z.array(z.object({
    step: z.number().int().positive(),
    name: z.string(),
    status: z.enum(["SUCCESS", "FAILED", "SKIPPED"]),
    durationMs: z.number().min(0),
    evidenceCount: z.number().int().min(0),
  })),
  model: z.object({ provider: z.string(), name: z.string(), latencyMs: z.number().int().min(0), status: z.enum(["COMPLETED", "UNAVAILABLE", "INVALID_OUTPUT", "TIMEOUT"]) }),
}).strict();
export type AnalyzeDisruptionResponse = z.infer<typeof AnalyzeDisruptionResponseSchema>;

export const DecideRecoveryRequestSchema = z.object({
  organizationId: z.string().min(1),
  disruptionId: z.string().min(1),
  optionId: z.string().min(1),
  role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "VIEWER"]),
}).strict();
export type DecideRecoveryRequest = z.infer<typeof DecideRecoveryRequestSchema>;

export const RECOVERY_API_PATHS = {
  demo: "/api/v1/demo/supply-chain",
  disruptions: "/api/v1/disruptions",
  assess: (id: string) => `/api/v1/disruptions/${encodeURIComponent(id)}/assess`,
  decide: (id: string) => `/api/v1/disruptions/${encodeURIComponent(id)}/decide`,
  context: (id: string) => `/internal/v1/disruptions/${encodeURIComponent(id)}/context`,
  health: "/internal/v1/health",
} as const;

