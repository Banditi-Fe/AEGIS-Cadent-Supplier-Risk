export const CASE_TYPES = [
  'OVERDUE_PAYMENT',
  'FAILED_PAYMENT',
  'REPEATED_FAILURE',
  'HIGH_RISK_CUSTOMER',
  'PAYMENT_ANOMALY',
  'MANUAL_REVIEW',
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_STATUSES = [
  'OPEN', 'ANALYZING', 'ACTION_PENDING', 'APPROVAL_REQUIRED',
  'IN_PROGRESS', 'RESOLVED', 'BLOCKED', 'FAILED', 'CLOSED',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ACTION_TYPES = [
  'SEND_PAYMENT_REMINDER',
  'CREATE_COLLECTION_CASE',
  'PLACE_ACCOUNT_HOLD',
  'REQUEST_HUMAN_REVIEW',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const DECISIONS = ['AUTO', 'APPROVAL', 'BLOCKED'] as const;
export type Decision = (typeof DECISIONS)[number];
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type ActorRole = 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER';
export type ActorType = 'USER' | 'AI' | 'SYSTEM' | 'INTEGRATION';

export interface TenantActor {
  userId: string;
  organizationId: string;
  role: ActorRole;
}

export interface CaseSummary {
  id: string;
  organizationId: string;
  customerId: string;
  invoiceId?: string | null;
  paymentId?: string | null;
  caseType: CaseType;
  status: CaseStatus;
  priority: number;
  createdAt: string;
}

export interface AiRecommendation {
  provider: string;
  model: string;
  caseId: string;
  recommendedAction: ActionType;
  confidence: number;
  summary: string;
  signals: string[];
  uncertainties: string[];
  /** AI output is evidence only and never grants permission to execute. */
  authorization?: never;
  decision?: never;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  factors: Array<{ code: string; points: number; detail: string }>;
  calculatedAt: string;
  engineVersion: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  role: ActorRole;
  actionType: ActionType;
  permission: string;
  reason: string;
}

export interface PolicyMatch {
  policyId: string;
  name: string;
  effect: Decision;
  reason: string;
  priority: number;
}

export interface DecisionResult {
  decision: Decision;
  reason: string;
  authorization: AuthorizationResult;
  risk: RiskAssessment;
  matchedPolicies: PolicyMatch[];
  aiConfidence: number | null;
}

export type ActionStatus =
  | 'PROPOSED' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'REJECTED'
  | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export interface ProposedAction {
  id: string;
  caseId: string;
  customerId: string;
  actionType: ActionType;
  status: ActionStatus;
  decision: Decision;
  decisionReason: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  actorType: ActorType;
  actorUserId?: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  previousHash?: string | null;
  eventHash: string;
  createdAt: string;
}

export interface ApiError {
  statusCode: number;
  code: string;
  message: string;
  correlationId?: string;
}

export * from './decision.js';
export * from './policy.js';
export * from './metrics.js';
export * from './audit-hash.js';
export * from './action-state.js';
