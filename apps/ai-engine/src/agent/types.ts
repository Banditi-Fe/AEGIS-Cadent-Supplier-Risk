import type { AnalyzeCaseError, AnalyzeCaseResponse } from "@aegis/contracts-ai";

export interface RunnerConfig {
  /** Per Core API tool call timeout (ms). */
  toolTimeoutMs: number;
  /** Strict per model call timeout (ms) - AI_REQUEST_TIMEOUT_MS. */
  llmTimeoutMs: number;
  /** Overall deadline for one run in ms (tools + model). Default 30000. */
  totalTimeoutMs?: number;
  /** Retries after a transient model failure (default 1). Independent from repairs. */
  maxRetries?: number;
  /** Repair attempts after an invalid model output (default 1). Independent from retries. */
  maxRepairs?: number;
}

/** Counters for tests / evaluation. NOT part of the public response contract. */
export interface RunDiagnostics {
  toolCalls: number;
  toolFailures: number;
  llmCalls: number;
  /** model calls that were a retry after a transient failure */
  retries: number;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  /** model outputs that were malformed / schema-invalid / rejected by the validator */
  invalidOutputs: number;
  /** model outputs rejected because of unknown / unsupported evidence or facts (hallucination) */
  evidenceValidationFailures: number;
  fallbackUsed: boolean;
  flaggedTextCount: number;
  issueCodes: string[];
}

export type RunResult =
  | { ok: true; httpStatus: 200; response: AnalyzeCaseResponse; diagnostics: RunDiagnostics }
  | { ok: false; httpStatus: number; error: AnalyzeCaseError; diagnostics: RunDiagnostics };
