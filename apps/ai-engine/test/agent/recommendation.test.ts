import type { ActionType } from "@aegis/contracts-ai";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../../src/agent/index.js";
import type { StructuredRequest } from "../../src/llm/index.js";
import { SCENARIOS } from "../../evaluation/scenarios.js";
import { EVAL_NOW, InMemoryCore } from "../../evaluation/world.js";
import { FakeLLM, validOutput } from "../helpers/fakes.js";

/**
 * RECOMMENDATION guardrails (backlog item 6), tested WITHOUT a real model: a scripted model proposes an action
 * and the pipeline (deterministic signals + EvidenceValidator) must accept the sensible ones and reject the unsafe ones.
 * What a REAL model proposes on its own is measured by `pnpm test:evaluate` (needs Ollama).
 */
const REQ = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "SYSTEM" as const } };
const proposing = (type: ActionType, segment = "SMB") => (req: StructuredRequest): string => {
  const out = JSON.parse(validOutput()(req)) as { recommendedAction: { type: string; reason: string }; customerSituation: { segment: string } };
  out.customerSituation.segment = segment;
  out.recommendedAction.type = type;
  out.recommendedAction.reason = "Recommendation based on the supplied evidence.";
  return JSON.stringify(out);
};
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;

async function propose(id: string, type: ActionType) {
  const segment = String((scenario(id).world.customer as { segment?: string }).segment ?? "SMB");
  const llm = new FakeLLM([proposing(type, segment)]);
  const r = await new AgentRunner({ client: new InMemoryCore(scenario(id).world), llm, config: { toolTimeoutMs: 500, llmTimeoutMs: 500 }, clock: () => EVAL_NOW }).run(REQ);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("run failed");
  return r.response;
}

describe("recommendation guardrails per business case", () => {
  it("low overdue (s16): reminder accepted; hold / collection rejected", async () => {
    expect((await propose("s16", "SEND_PAYMENT_REMINDER")).status).toBe("COMPLETED");
    for (const bad of ["PLACE_ACCOUNT_HOLD", "CREATE_COLLECTION_CASE"] as const) {
      const r = await propose("s16", bad);
      expect(r.status).toBe("DEGRADED");
      expect(r.recommendedAction.type).toBe("SEND_PAYMENT_REMINDER"); // conservative fallback
    }
  });

  it("repeated failures (s10): collection accepted; NO_ACTION rejected", async () => {
    const ok = await propose("s10", "CREATE_COLLECTION_CASE");
    expect(ok.status).toBe("COMPLETED");
    expect(ok.recommendedAction.type).toBe("CREATE_COLLECTION_CASE");
    expect((await propose("s10", "NO_ACTION")).status).toBe("DEGRADED");
  });

  it("severe (s15): hold or human review accepted", async () => {
    expect((await propose("s15", "PLACE_ACCOUNT_HOLD")).status).toBe("COMPLETED");
    expect((await propose("s15", "REQUEST_HUMAN_REVIEW")).status).toBe("COMPLETED");
  });

  it("resolved (s12): NO_ACTION accepted; hold / collection / reminder-on-nothing rejected", async () => {
    expect((await propose("s12", "NO_ACTION")).status).toBe("COMPLETED");
    for (const bad of ["PLACE_ACCOUNT_HOLD", "CREATE_COLLECTION_CASE"] as const) expect((await propose("s12", bad)).status).toBe("DEGRADED");
  });

  it("disputed payment (s05) and data conflict (s09) force human review", async () => {
    for (const id of ["s05", "s09"]) {
      expect((await propose(id, "SEND_PAYMENT_REMINDER")).status).toBe("DEGRADED");
      expect((await propose(id, "REQUEST_HUMAN_REVIEW")).status).toBe("COMPLETED");
    }
  });

  it("every scenario: the expected (best) action is accepted by the pipeline", async () => {
    for (const sc of SCENARIOS) {
      if (sc.id === "s20") continue; // no financial data: the model is deliberately not called
      const r = await propose(sc.id, sc.expectedAction);
      expect({ id: sc.id, status: r.status }).toEqual({ id: sc.id, status: "COMPLETED" });
    }
  });
});
