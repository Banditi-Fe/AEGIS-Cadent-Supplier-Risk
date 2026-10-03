import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  AI_SCHEMA_VERSION,
  AnalyzeCaseResponseSchema,
  TOOL_NAMES,
  type AnalyzeCaseRequest,
  type AnalyzeCaseResponse,
  type DegradedReason,
  type LlmAnalysisOutput,
  type ModelMetadata,
  type ToolName,
  type TraceStep,
} from "@aegis/contracts-ai";
import {
  EVIDENCE_ISSUE_CODES,
  EvidenceStore,
  EvidenceValidator,
  detectSignals,
  emptyFacts,
  parseLlmJson,
  type CollectedFacts,
  type ValidationIssue,
} from "../evidence/index.js";
import { resolveFacts } from "../evidence/signals.js";
import { buildFallbackAnalysis } from "../fallback/index.js";
import { LLMError, type LLMProvider } from "../llm/index.js";
import { buildAnalysisPrompt, buildRepairPrompt } from "../prompts/analysis.js";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { LLM_OUTPUT_JSON_SCHEMA } from "../schemas/index.js";
import { TOOLS, ToolBudget, executeTool, type CoreApiClient, type ToolExecution } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import type { RunDiagnostics, RunResult, RunnerConfig } from "./types.js";

/** Defaults: 1 normal call + at most 1 retry (transient failure) + at most 1 repair (invalid output) = up to 3 calls. */
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_MAX_REPAIRS = 1;
/** Kept for backwards compatibility: the old shared budget of 2 calls. */
export const MAX_LLM_ATTEMPTS = 2;
const MAX_UNCERTAINTIES = 20;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
/** A model call with less than this left on the overall deadline is pointless: go straight to the fallback. */
const MIN_LLM_WINDOW_MS = 500;

export interface AgentRunnerDeps {
  client: CoreApiClient;
  llm: LLMProvider;
  config: RunnerConfig;
  logger?: Logger;
  clock?: () => Date;
  idGenerator?: () => string;
}

export interface RunOptions {
  requestId?: string;
}

class Trace {
  readonly steps: TraceStep[] = [];
  add(s: Omit<TraceStep, "step">): void {
    this.steps.push({ step: this.steps.length + 1, ...s });
  }
}

const LLM_REASON: Record<string, { reason: DegradedReason; status: ModelMetadata["status"] }> = {
  UNAVAILABLE: { reason: "LLM_UNAVAILABLE", status: "UNAVAILABLE" },
  TIMEOUT: { reason: "LLM_TIMEOUT", status: "TIMEOUT" },
  OVERLOADED: { reason: "LLM_OVERLOADED", status: "OVERLOADED" },
  TRANSIENT: { reason: "LLM_UNAVAILABLE", status: "UNAVAILABLE" },
  BAD_REQUEST: { reason: "LLM_UNAVAILABLE", status: "UNAVAILABLE" },
};

const CASE_ERROR: Record<string, { code: "CASE_NOT_FOUND" | "CORE_API_UNAUTHORIZED" | "CASE_DATA_INVALID" | "CORE_API_UNAVAILABLE"; http: number }> = {
  NOT_FOUND: { code: "CASE_NOT_FOUND", http: 404 },
  UNAUTHORIZED: { code: "CORE_API_UNAUTHORIZED", http: 502 },
  INVALID_RESPONSE: { code: "CASE_DATA_INVALID", http: 502 },
};

const unique = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Multi-step, READ-ONLY investigation. Phases:
 * INITIALIZE -> PLAN -> COLLECT -> NORMALIZE -> SIGNAL_DETECTION -> LLM_ANALYSIS -> EVIDENCE_VALIDATION
 * -> RECOMMEND -> CONFIDENCE -> RETURN.
 * It only recommends. AUTO / APPROVAL / BLOCKED is decided by Core API, never here.
 * The trace only contains steps that really happened (real timestamps, real durations, real tool calls).
 */
export class AgentRunner {
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.idGenerator ?? (() => `run_${randomUUID()}`);
  }

  async run(req: AnalyzeCaseRequest, opts: RunOptions = {}): Promise<RunResult> {
    const { clock, deps } = this;
    const trace = new Trace();
    const diag: RunDiagnostics = {
      toolCalls: 0,
      toolFailures: 0,
      llmCalls: 0,
      retries: 0,
      repairAttempted: false,
      repairSucceeded: false,
      invalidOutputs: 0,
      evidenceValidationFailures: 0,
      fallbackUsed: false,
      flaggedTextCount: 0,
      issueCodes: [],
    };
    const begin = () => {
      const startedAt = clock().toISOString();
      const t0 = performance.now();
      return { startedAt, ms: () => Math.round(performance.now() - t0) };
    };

    const totalMs = deps.config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    const deadline = performance.now() + totalMs;
    const remainingMs = (): number => deadline - performance.now();

    /* ---------------------------------------------------------- Phase 1: INITIALIZE */
    const init = begin();
    const agentRunId = this.newId();
    const startedAt = init.startedAt;
    const now = clock();
    const log = deps.logger?.child({ agentRunId, caseId: req.caseId, requestId: opts.requestId });
    trace.add({ phase: "INITIALIZE", name: "Initialize agent run", type: "REASONING", status: "SUCCESS", startedAt, durationMs: init.ms(), detail: "agentRunId, startedAt and caseId recorded" });

    const fail = (httpStatus: number, code: Parameters<typeof failBody>[0], message: string): RunResult => ({
      ok: false,
      httpStatus,
      error: failBody(code, message, agentRunId, req.caseId, trace.steps).error,
      diagnostics: diag,
    });

    /* ---------------------------------------------------------------- Phase 2: PLAN */
    const plan = begin();
    const budget = new ToolBudget();
    const dependentTools = TOOL_NAMES.filter((t) => t !== "get_case");
    trace.add({
      phase: "PLAN",
      name: "Plan read-only investigation",
      type: "REASONING",
      status: "SUCCESS",
      startedAt: plan.startedAt,
      durationMs: plan.ms(),
      detail: `get_case first, then in parallel: ${dependentTools.join(", ")} (max ${budget.max} business-data tool calls)`,
    });

    const toolDeps = {
      client: deps.client,
      budget,
      timeoutMs: deps.config.toolTimeoutMs,
      clock,
      requestId: opts.requestId,
      agentRunId,
      remainingMs,
    };
    const baseCtx: ToolContext = { organizationId: req.organizationId, caseId: req.caseId, customerId: req.customerId, now };
    const traceTool = (e: ToolExecution): void => {
      diag.toolCalls += 1;
      if (e.status === "FAILED") diag.toolFailures += 1;
      trace.add({
        phase: "COLLECT",
        name: `Call ${e.tool}`,
        type: "TOOL",
        status: e.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        startedAt: e.startedAt,
        durationMs: e.durationMs,
        tool: e.tool,
        recordCount: e.recordCount,
        ...(e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {}),
        ...(e.errorCode ? { errorCode: e.errorCode } : {}),
        evidence: e.evidence,
      });
    };

    /* -------------------------------------------------------- Phase 3: COLLECT (case) */
    const caseExec = await executeTool(TOOLS.get_case, baseCtx, toolDeps);
    traceTool(caseExec);
    if (caseExec.status === "FAILED") {
      const m = CASE_ERROR[caseExec.errorCode ?? ""] ?? { code: "CORE_API_UNAVAILABLE" as const, http: 502 };
      log?.warn({ errorCode: caseExec.errorCode }, "case could not be loaded");
      return fail(m.http, m.code, "The case could not be loaded from Core API.");
    }
    const caseFact = caseExec.facts.case;
    // The request body is NOT trusted: the case from Core API decides organization and customer.
    if (caseFact?.organizationId && caseFact.organizationId !== req.organizationId) {
      return fail(403, "CASE_SCOPE_MISMATCH", "The case does not belong to the requested organization.");
    }
    if (caseFact?.customerId && caseFact.customerId !== req.customerId) {
      return fail(409, "CASE_SCOPE_MISMATCH", "The case does not belong to the requested customer.");
    }
    const customerId = caseFact?.customerId ?? req.customerId;
    const ctx: ToolContext = { ...baseCtx, customerId };

    /* ------------------------------------------- Phase 3: COLLECT (parallel, read-only) */
    const settled = await Promise.all(dependentTools.map((t) => executeTool(TOOLS[t], ctx, toolDeps)));
    for (const e of settled) traceTool(e);
    const executions: ToolExecution[] = [caseExec, ...settled];

    const customerFact = settled.find((e) => e.tool === "get_customer")?.facts.customer;
    if (customerFact?.organizationId && customerFact.organizationId !== req.organizationId) {
      return fail(403, "CASE_SCOPE_MISMATCH", "The customer does not belong to the requested organization.");
    }

    /* ------------------------------------------------------------ Phase 4: NORMALIZE */
    const norm = begin();
    const facts: CollectedFacts = emptyFacts();
    const store = new EvidenceStore();
    for (const e of executions) {
      Object.assign(facts, e.facts);
      facts.toolStatus[e.tool] = e.status === "SUCCESS" ? "SUCCESS" : "FAILED";
      facts.notes.push(...e.notes);
      store.addAll(e.evidence, e.untrustedIds);
      diag.flaggedTextCount += e.flaggedTextCount;
    }
    trace.add({
      phase: "NORMALIZE",
      name: "Normalize evidence",
      type: "REASONING",
      status: "SUCCESS",
      startedAt: norm.startedAt,
      durationMs: norm.ms(),
      recordCount: store.size,
      detail: `${store.size} canonical evidence records${diag.flaggedTextCount ? `; ${diag.flaggedTextCount} instruction-like text field(s) withheld` : ""}`,
    });

    /* ------------------------------------------------------ Phase 5: SIGNAL_DETECTION */
    const sig = begin();
    const signals = detectSignals(facts);
    trace.add({
      phase: "SIGNAL_DETECTION",
      name: "Detect deterministic signals",
      type: "REASONING",
      status: "SUCCESS",
      startedAt: sig.startedAt,
      durationMs: sig.ms(),
      recordCount: signals.length,
      detail: signals.length ? signals.map((s) => s.code).join(", ") : "no signals",
    });

    const failedTools = dependentTools.filter((t) => facts.toolStatus[t] !== "SUCCESS");
    const hasFinancialData = resolveFacts(facts).hasFinancialData;

    /* ------------------------------------------------- Phase 6/7: LLM + VALIDATION */
    let analysis: LlmAnalysisOutput | undefined;
    let degraded: DegradedReason[] = [];
    let modelStatus: ModelMetadata["status"] = "COMPLETED";
    let attempts = 0;
    let llmLatency = 0;

    if (!hasFinancialData) {
      // Nothing financial could be read: do not ask a model to reason about nothing.
      const t = begin();
      trace.add({ phase: "LLM_ANALYSIS", name: "LLM analysis skipped", type: "LLM", status: "SKIPPED", startedAt: t.startedAt, durationMs: 0, detail: "metrics, invoices and payments are all unavailable" });
      degraded = ["PARTIAL_EVIDENCE"];
      modelStatus = "UNAVAILABLE";
    } else {
      const validator = new EvidenceValidator(store, signals, facts);
      const basePrompt = buildAnalysisPrompt({ caseId: req.caseId, signals, store, facts, now });
      let prompt = basePrompt;
      let isRepair = false;
      let isRetry = false;
      const maxRetries = Math.max(0, deps.config.maxRetries ?? DEFAULT_MAX_RETRIES);
      const maxRepairs = Math.max(0, deps.config.maxRepairs ?? DEFAULT_MAX_REPAIRS);
      const maxAttempts = 1 + maxRetries + maxRepairs;
      let retriesUsed = 0;
      let repairsUsed = 0;

      while (attempts < maxAttempts && !analysis) {
        if (remainingMs() < MIN_LLM_WINDOW_MS) {
          const t0 = begin();
          trace.add({ phase: "LLM_ANALYSIS", name: "LLM analysis skipped (deadline)", type: "LLM", status: "SKIPPED", startedAt: t0.startedAt, durationMs: 0, detail: `overall ${totalMs} ms deadline reached` });
          modelStatus = "TIMEOUT";
          degraded = ["LLM_TIMEOUT"];
          break;
        }
        attempts += 1;
        diag.llmCalls += 1;
        if (isRetry) diag.retries += 1;
        const t = begin();
        let text: string;
        try {
          const r = await deps.llm.generateStructured({ system: SYSTEM_PROMPT, user: prompt, jsonSchema: LLM_OUTPUT_JSON_SCHEMA, timeoutMs: Math.max(1, Math.min(deps.config.llmTimeoutMs, Math.floor(remainingMs()))) });
          text = r.text;
          llmLatency += r.latencyMs;
          trace.add({
            phase: "LLM_ANALYSIS",
            name: isRepair ? "LLM repair attempt" : isRetry ? "LLM analysis (retry)" : "LLM analysis",
            type: "LLM",
            status: "SUCCESS",
            startedAt: t.startedAt,
            durationMs: t.ms(),
            attempt: attempts,
          });
        } catch (err) {
          const e = err instanceof LLMError ? err : new LLMError("TRANSIENT", "unexpected model error");
          llmLatency += t.ms();
          const m = LLM_REASON[e.kind] ?? { reason: "LLM_UNAVAILABLE" as const, status: "UNAVAILABLE" as const };
          trace.add({ phase: "LLM_ANALYSIS", name: isRetry ? "LLM analysis (retry)" : "LLM analysis", type: "LLM", status: "FAILED", startedAt: t.startedAt, durationMs: t.ms(), attempt: attempts, errorCode: e.kind });
          log?.warn({ kind: e.kind, attempt: attempts }, "model call failed");
          modelStatus = m.status;
          degraded = [m.reason];
          if (e.retryable && retriesUsed < maxRetries) {
            retriesUsed += 1;
            isRetry = true;
            continue; // single retry, only for transient failures
          }
          break; // timeout / offline are not retried: strict latency
        }

        const v = begin();
        const parsed = parseLlmJson(text);
        let issues: ValidationIssue[];
        let result: ReturnType<EvidenceValidator["validate"]> | undefined;
        if (!parsed.ok) {
          issues = [{ code: "MALFORMED_JSON", path: "$", message: parsed.error }];
        } else {
          result = validator.validate(parsed.value);
          issues = result.ok ? [] : result.issues;
        }
        if (result?.ok) {
          analysis = result.output;
          modelStatus = "COMPLETED";
          degraded = [];
          if (isRepair) diag.repairSucceeded = true;
          trace.add({ phase: "EVIDENCE_VALIDATION", name: "Validate evidence", type: "VALIDATION", status: "SUCCESS", startedAt: v.startedAt, durationMs: v.ms(), attempt: attempts, detail: "all evidence ids, facts, enums and confidence verified" });
          break;
        }

        diag.invalidOutputs += 1;
        if (issues.some((i) => EVIDENCE_ISSUE_CODES.has(i.code))) diag.evidenceValidationFailures += 1;
        diag.issueCodes.push(...issues.map((i) => i.code));
        const codes = unique(issues.map((i) => i.code));
        trace.add({ phase: "EVIDENCE_VALIDATION", name: "Validate evidence", type: "VALIDATION", status: "FAILED", startedAt: v.startedAt, durationMs: v.ms(), attempt: attempts, errorCode: codes[0], detail: `rejected: ${codes.join(", ")}`.slice(0, 500) });
        modelStatus = "INVALID_OUTPUT";
        degraded = [codes.every((c) => c === "MALFORMED_JSON") ? "LLM_MALFORMED_OUTPUT" : "LLM_INVALID_OUTPUT"];
        if (repairsUsed < maxRepairs && attempts < maxAttempts) {
          // ONE repair attempt: same data + the validation problems.
          repairsUsed += 1;
          diag.repairAttempted = true;
          isRepair = true;
          isRetry = false;
          prompt = buildRepairPrompt(basePrompt, text, issues);
        } else {
          // Invalid structured output is not a transient transport failure.
          // Stop when the repair budget is exhausted instead of spending retry budget on malformed output.
          break;
        }
      }
    }

    /* ------------------------------------------------- Fallback (DEGRADED, never AUTO) */
    let status: AnalyzeCaseResponse["status"] = "COMPLETED";
    if (!analysis) {
      const fb = begin();
      analysis = buildFallbackAnalysis(facts, signals, store);
      status = "DEGRADED";
      diag.fallbackUsed = true;
      trace.add({ phase: "RECOMMEND", name: "Deterministic fallback recommendation", type: "REASONING", status: "SUCCESS", startedAt: fb.startedAt, durationMs: fb.ms(), detail: `degraded: ${degraded.join(", ")}` });
    } else {
      const rc = begin();
      trace.add({ phase: "RECOMMEND", name: "Select recommended action", type: "REASONING", status: "SUCCESS", startedAt: rc.startedAt, durationMs: rc.ms(), detail: `${analysis.recommendedAction.type} / ${analysis.recommendedAction.priority}` });
    }

    /* -------------------------------------------------------------- Phase 9: CONFIDENCE */
    const conf = begin();
    const cap = Math.max(0.3, 1 - 0.1 * failedTools.length);
    const confidence = Math.round(Math.min(analysis.confidence, cap) * 100) / 100;
    const uncertainties = [
      ...analysis.uncertainties,
      ...failedTools.map((t: ToolName) => `Data source ${t} was unavailable; related facts are unknown.`),
      ...facts.notes,
    ]
      .map((u) => u.slice(0, 500))
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, MAX_UNCERTAINTIES);
    trace.add({
      phase: "CONFIDENCE",
      name: "Calibrate confidence",
      type: "REASONING",
      status: "SUCCESS",
      startedAt: conf.startedAt,
      durationMs: conf.ms(),
      detail: confidence < analysis.confidence ? `capped to ${confidence} (${failedTools.length} source(s) unavailable)` : `confidence ${confidence}`,
    });

    /* ---------------------------------------------------------------- Phase 10: RETURN */
    const ret = begin();
    const cited = unique([...analysis.signals.flatMap((s) => s.evidenceIds), ...analysis.recommendedAction.evidenceIds]);
    const completedAt = clock().toISOString();
    trace.add({ phase: "RETURN", name: "Return structured result", type: "REASONING", status: "SUCCESS", startedAt: ret.startedAt, durationMs: ret.ms() });

    const candidate: AnalyzeCaseResponse = {
      schemaVersion: AI_SCHEMA_VERSION,
      agentRunId,
      caseId: req.caseId,
      organizationId: req.organizationId,
      customerId,
      status,
      degradedReasons: status === "DEGRADED" ? degraded : [],
      summary: analysis.summary,
      customerSituation: analysis.customerSituation,
      signals: analysis.signals,
      recommendedAction: analysis.recommendedAction,
      confidence,
      uncertainties,
      nextBestStep: analysis.nextBestStep,
      evidence: store.byIds(cited),
      toolTrace: trace.steps,
      model: {
        provider: deps.llm.provider,
        name: deps.llm.model,
        model: deps.llm.model,
        latencyMs: Math.round(llmLatency),
        attempt: attempts,
        status: modelStatus,
      },
      startedAt,
      completedAt,
    };
    const checked = AnalyzeCaseResponseSchema.safeParse(candidate);
    if (!checked.success) {
      log?.error({ issues: checked.error.issues.length }, "response failed contract validation");
      return fail(500, "INTERNAL_ERROR", "The analysis result could not be produced.");
    }
    log?.info({ status, action: analysis.recommendedAction.type, attempts, toolFailures: diag.toolFailures }, "analysis finished");
    return { ok: true, httpStatus: 200, response: checked.data, diagnostics: diag };
  }
}

function failBody(
  code: "INVALID_REQUEST" | "UNAUTHORIZED" | "CASE_NOT_FOUND" | "CASE_SCOPE_MISMATCH" | "CORE_API_UNAUTHORIZED" | "CORE_API_UNAVAILABLE" | "CASE_DATA_INVALID" | "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
  agentRunId: string,
  caseId: string,
  toolTrace: TraceStep[],
) {
  return { error: { schemaVersion: AI_SCHEMA_VERSION, status: "FAILED" as const, agentRunId, caseId, error: { code, message }, toolTrace } };
}


