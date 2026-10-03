import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent/index.js";
import { LLMError, type LLMProvider } from "../src/llm/index.js";
import { SCENARIOS } from "../evaluation/scenarios.js";
import { EVAL_NOW, InMemoryCore } from "../evaluation/world.js";

const offline: LLMProvider = {
  provider: "ollama",
  model: "none",
  async generateStructured() {
    throw new LLMError("UNAVAILABLE", "off");
  },
  async health() {
    return { ok: false, latencyMs: 0 };
  },
};
const run = (i: number) =>
  new AgentRunner({ client: new InMemoryCore(SCENARIOS[i]!.world), llm: offline, config: { toolTimeoutMs: 500, llmTimeoutMs: 500 }, clock: () => EVAL_NOW }).run({
    organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "SYSTEM" },
  });

describe("evaluation dataset (deterministic part)", () => {
  it("has at least 20 scenarios with unique ids", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  SCENARIOS.forEach((sc, i) => {
    it(`${sc.id} ${sc.title}: signals + safe fallback`, async () => {
      const r = await run(i);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.response.status).toBe("DEGRADED");
      expect([...new Set(r.response.signals.map((s) => s.code))].sort()).toEqual([...sc.expectedSignals].sort());
      expect(r.response.recommendedAction.type).toBe(sc.expectedFallbackAction);
      // fallback never recommends hold / collection by itself and never carries an authority decision
      expect(["REQUEST_HUMAN_REVIEW", "SEND_PAYMENT_REMINDER", "NO_ACTION"]).toContain(r.response.recommendedAction.type);
      expect(JSON.stringify(r.response)).not.toMatch(/"(AUTO|APPROVAL|BLOCKED)"/);
      expect(r.response.recommendedAction.evidenceIds.every((id) => r.response.evidence.some((e) => e.evidenceId === id))).toBe(true);
    });
  });
});
