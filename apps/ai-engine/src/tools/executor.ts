import type { EvidenceRecord, ToolName } from "@aegis/contracts-ai";
import { HARD_MAX_TOOL_CALLS } from "../config/index.js";
import { CoreApiError, type CoreApiClient } from "./coreApiClient.js";
import { inspectPayload } from "./shapes.js";
import { ToolDataError, type ParsedFacts, type ReadOnlyTool, type ToolContext } from "./types.js";

/** Hard cap on business-data tool calls per agent run. */
export class ToolBudget {
  private _used = 0;
  constructor(readonly max: number = HARD_MAX_TOOL_CALLS) {}
  get used(): number {
    return this._used;
  }
  /** Returns false (and does NOT count) when the budget is exhausted. */
  consume(): boolean {
    if (this._used >= this.max) return false;
    this._used += 1;
    return true;
  }
}

export interface ToolExecution {
  tool: ToolName;
  status: "SUCCESS" | "FAILED";
  startedAt: string;
  durationMs: number;
  recordCount: number;
  evidence: EvidenceRecord[];
  untrustedIds: string[];
  flaggedTextCount: number;
  facts: ParsedFacts;
  notes: string[];
  httpStatus?: number;
  errorCode?: string;
}

export interface ExecutorDeps {
  client: CoreApiClient;
  budget: ToolBudget;
  timeoutMs: number;
  clock: () => Date;
  requestId?: string;
  agentRunId?: string;
  /** Milliseconds left until the overall request deadline (undefined = no overall deadline). */
  remainingMs?: () => number;
}

/** Executes ONE read-only tool. Never throws: failures are recorded, nothing is fabricated. */
export async function executeTool(tool: ReadOnlyTool, ctx: ToolContext, deps: ExecutorDeps): Promise<ToolExecution> {
  const startedAt = deps.clock().toISOString();
  const t0 = performance.now();
  const base = { tool: tool.name, startedAt, evidence: [], untrustedIds: [], flaggedTextCount: 0, facts: {}, notes: [], recordCount: 0 };
  const elapsed = () => Math.round(performance.now() - t0);

  if (!deps.budget.consume()) {
    return { ...base, status: "FAILED", durationMs: elapsed(), errorCode: "TOOL_BUDGET_EXCEEDED" };
  }
  const remaining = deps.remainingMs?.();
  if (remaining !== undefined && remaining <= 0) {
    return { ...base, status: "FAILED", durationMs: elapsed(), errorCode: "DEADLINE_EXCEEDED" };
  }
  try {
    const raw = await deps.client.get(tool.path(ctx), {
      timeoutMs: remaining === undefined ? deps.timeoutMs : Math.max(1, Math.min(deps.timeoutMs, Math.floor(remaining))),
      requestId: deps.requestId,
      agentRunId: deps.agentRunId,
      organizationId: ctx.organizationId,
    });
    const shape = inspectPayload(tool.name, raw);
    if (shape.fatal) throw new ToolDataError("INVALID_RESPONSE", shape.fatal);
    const parsed = tool.parse(raw, { ...ctx, observedAt: deps.clock().toISOString() });
    return {
      tool: tool.name,
      status: "SUCCESS",
      startedAt,
      durationMs: elapsed(),
      recordCount: parsed.recordCount,
      evidence: parsed.evidence,
      untrustedIds: parsed.untrustedIds,
      flaggedTextCount: parsed.flaggedTextCount,
      facts: parsed.facts,
      notes: [...shape.notes, ...(parsed.notes ?? [])],
    };
  } catch (err) {
    if (err instanceof CoreApiError) {
      return { ...base, status: "FAILED", durationMs: elapsed(), errorCode: err.code, httpStatus: err.httpStatus };
    }
    if (err instanceof ToolDataError) {
      return { ...base, status: "FAILED", durationMs: elapsed(), errorCode: err.code };
    }
    return { ...base, status: "FAILED", durationMs: elapsed(), errorCode: "INTERNAL_ERROR" };
  }
}
