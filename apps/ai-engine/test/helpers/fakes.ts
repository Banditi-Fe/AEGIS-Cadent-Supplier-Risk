import { CoreApiError, type CoreApiClient } from "../../src/tools/index.js";
import { LLMError, type LLMProvider, type StructuredRequest, type StructuredResult } from "../../src/llm/index.js";
import { MARKERS } from "../../src/prompts/analysis.js";

export const NOW = new Date("2026-10-03T10:00:00Z");
export const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

export interface World {
  case?: unknown;
  customer?: unknown;
  metrics?: unknown;
  invoices?: unknown;
  payments?: unknown;
  cases?: unknown;
  fail?: Partial<Record<"case" | "customer" | "metrics" | "invoices" | "payments" | "cases", CoreApiError>>;
}

export function baseWorld(over: Partial<World> = {}): World {
  return {
    case: { id: "case_1", number: "CASE-1", customerId: "cus_1", organizationId: "org_1", status: "OPEN" },
    customer: { id: "cus_1", organizationId: "org_1", name: "Acme", segment: "SMB", status: "ACTIVE" },
    metrics: { overdueAmount: 1200, totalOutstanding: 1200, maxOverdueDays: 45, failedPayments30d: 1, currency: "EUR" },
    invoices: [{ id: "inv_1", number: "INV-1", amount: 1200, status: "OPEN", dueDate: daysAgo(45), currency: "EUR" }],
    payments: [{ id: "pay_1", status: "FAILED", attemptedAt: daysAgo(5), amount: 1200 }],
    cases: [],
    ...over,
  };
}

/** In-memory read-only Core API. Records every requested path and method. */
export class FakeCore implements CoreApiClient {
  readonly calls: string[] = [];
  constructor(private readonly w: World) {}
  async get(path: string): Promise<unknown> {
    this.calls.push(path);
    const key = path.endsWith("/metrics") ? "metrics" : path.endsWith("/invoices") ? "invoices" : path.endsWith("/payments") ? "payments" : path.endsWith("/cases") ? "cases" : path.includes("/cases/") ? "case" : "customer";
    const err = this.w.fail?.[key];
    if (err) throw err;
    return this.w[key];
  }
}

export type LlmStep = string | LLMError | ((req: StructuredRequest) => string);

/** Scripted model: every call consumes the next step. */
export class FakeLLM implements LLMProvider {
  readonly provider = "ollama";
  readonly model = "test-model";
  readonly requests: StructuredRequest[] = [];
  constructor(private readonly steps: LlmStep[]) {}
  async generateStructured(req: StructuredRequest): Promise<StructuredResult> {
    this.requests.push(req);
    const s = this.steps[this.requests.length - 1] ?? this.steps[this.steps.length - 1];
    if (s instanceof LLMError) throw s;
    return { text: typeof s === "function" ? s(req) : (s as string), provider: this.provider, model: this.model, latencyMs: 5 };
  }
  async health() {
    return { ok: true, latencyMs: 1, modelAvailable: true };
  }
}

/** Builds a valid analysis from the signals/evidence that are really in the prompt (no hardcoded ids). */
export function validOutput(over: Record<string, unknown> = {}): (req: StructuredRequest) => string {
  return (req) => {
    const lines = req.user.split("\n");
    const signals = JSON.parse(lines[lines.indexOf(MARKERS.signals) + 1] ?? "[]") as Array<{ code: string; severity: string; evidenceIds: string[]; explanation: string }>;
    const firstEvidence = (lines[lines.indexOf(MARKERS.evidence) + 1] ?? "").split(" => ")[0] as string;
    const ids = signals[0]?.evidenceIds[0] ?? firstEvidence;
    return JSON.stringify({
      summary: "Overdue exposure detected from the supplied evidence.",
      customerSituation: { segment: "SMB", paymentBehavior: "DELAYED" },
      signals,
      recommendedAction: { type: "REQUEST_HUMAN_REVIEW", priority: "MEDIUM", reason: "Overdue exposure with a failed payment.", evidenceIds: [ids] },
      confidence: 0.9,
      uncertainties: [],
      nextBestStep: "Route to a reviewer.",
      ...over,
    });
  };
}
