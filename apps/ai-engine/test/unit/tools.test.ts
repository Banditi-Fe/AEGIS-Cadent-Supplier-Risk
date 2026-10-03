import { ToolResultSchema, TOOL_NAMES } from "@aegis/contracts-ai";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../../src/agent/index.js";
import { CoreApiError, TOOLS, ToolBudget, executeTool, inspectPayload, type CoreApiClient } from "../../src/tools/index.js";
import { CTX } from "../helpers/context.js";
import { FakeCore, FakeLLM, NOW, baseWorld, validOutput } from "../helpers/fakes.js";

const REQ = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "SYSTEM" as const } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ToolBudget / max 6 tool calls", () => {
  it("allows exactly 6 and does not count refused attempts", () => {
    const b = new ToolBudget();
    expect(b.max).toBe(6);
    for (let i = 0; i < 6; i++) expect(b.consume()).toBe(true);
    expect(b.consume()).toBe(false);
    expect(b.consume()).toBe(false);
    expect(b.used).toBe(6);
  });

  it("executor refuses the 7th call without touching Core API", async () => {
    const core = new FakeCore(baseWorld());
    const deps = { client: core, budget: new ToolBudget(2), timeoutMs: 500, clock: () => NOW };
    expect((await executeTool(TOOLS.get_case, CTX, deps)).status).toBe("SUCCESS");
    expect((await executeTool(TOOLS.get_customer, CTX, deps)).status).toBe("SUCCESS");
    const third = await executeTool(TOOLS.get_customer_metrics, CTX, deps);
    expect(third).toMatchObject({ status: "FAILED", errorCode: "TOOL_BUDGET_EXCEEDED" });
    expect(core.calls).toHaveLength(2);
  });

  it("a full run never makes more than 6 Core API calls", async () => {
    const core = new FakeCore(baseWorld());
    const r = await new AgentRunner({ client: core, llm: new FakeLLM([validOutput()]), config: { toolTimeoutMs: 500, llmTimeoutMs: 500 }, clock: () => NOW }).run(REQ);
    expect(r.ok).toBe(true);
    expect(core.calls.length).toBeLessThanOrEqual(6);
    expect(new Set(core.calls).size).toBe(core.calls.length); // no duplicate calls
  });
});

describe("executor: failures are recorded, never thrown or fabricated", () => {
  const run = (client: CoreApiClient, tool = TOOLS.get_customer_metrics, extra = {}) =>
    executeTool(tool, CTX, { client, budget: new ToolBudget(), timeoutMs: 500, clock: () => NOW, ...extra });

  it("CoreApiError -> FAILED with its code and http status; unexpected error -> INTERNAL_ERROR", async () => {
    expect(await run({ get: async () => { throw new CoreApiError("TIMEOUT", "t"); } })).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT", evidence: [] });
    expect(await run({ get: async () => { throw new CoreApiError("HTTP_ERROR", "x", 503); } })).toMatchObject({ errorCode: "HTTP_ERROR", httpStatus: 503 });
    expect(await run({ get: async () => { throw new Error("kaboom"); } })).toMatchObject({ status: "FAILED", errorCode: "INTERNAL_ERROR" });
  });

  it("unusable payloads -> INVALID_RESPONSE (no silent empty data)", async () => {
    expect(await run({ get: async () => "just a string" })).toMatchObject({ status: "FAILED", errorCode: "INVALID_RESPONSE" });
    expect(await run({ get: async () => ({ unrelated: 1 }) })).toMatchObject({ status: "FAILED", errorCode: "INVALID_RESPONSE" });
    expect(await run({ get: async () => [{ x: 1 }] }, TOOLS.get_open_invoices)).toMatchObject({ errorCode: "INVALID_RESPONSE" });
    expect(await run({ get: async () => ({ notAList: true }) }, TOOLS.get_payment_history)).toMatchObject({ errorCode: "INVALID_RESPONSE" });
  });

  it("overall deadline: no call is made once the deadline is reached; remaining time shrinks the per-call timeout", async () => {
    let called = 0;
    const seen: number[] = [];
    const client: CoreApiClient = { get: async (_p, o) => { called += 1; seen.push(o.timeoutMs); return { overdueAmount: 1 }; } };
    expect(await run(client, TOOLS.get_customer_metrics, { remainingMs: () => 0 })).toMatchObject({ status: "FAILED", errorCode: "DEADLINE_EXCEEDED" });
    expect(called).toBe(0);
    await run(client, TOOLS.get_customer_metrics, { remainingMs: () => 120 });
    expect(seen[0]).toBeLessThanOrEqual(120);
    await run(client, TOOLS.get_customer_metrics, { remainingMs: () => 99_999 });
    expect(seen[1]).toBe(500);
  });
});

describe("inspectPayload (Core API shape check)", () => {
  it("canonical shapes pass without notes", () => {
    expect(inspectPayload("get_open_invoices", [{ id: "i", amount: 5, status: "OPEN" }])).toEqual({ notes: [] });
    expect(inspectPayload("get_payment_history", { data: [{ id: "p", status: "FAILED" }] })).toEqual({ notes: [] });
    expect(inspectPayload("get_customer_metrics", { overdueAmount: 10 })).toEqual({ notes: [] });
    expect(inspectPayload("get_case", { id: "c", status: "OPEN" })).toEqual({ notes: [] });
  });
  it("partial loss and contract deviation are reported with field names only (no values)", () => {
    const r = inspectPayload("get_open_invoices", [{ id: "i", amount: 5 }, { weird: "SECRET-VALUE" }]);
    expect(r.fatal).toBeUndefined();
    expect(r.notes.join(" ")).toContain("1 of 2");
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE");
    const dev = inspectPayload("get_open_invoices", [{ invoiceId: "i", amountDue: 5 }]);
    expect(dev.notes.join(" ")).toContain("deviates");
  });
  it("empty list is valid (customer without invoices)", () => {
    expect(inspectPayload("get_open_invoices", [])).toEqual({ notes: [] });
  });
  it("fatal for nothing recognisable", () => {
    expect(inspectPayload("get_open_invoices", [{ a: 1 }]).fatal).toBeDefined();
    expect(inspectPayload("get_customer_metrics", {}).fatal).toBeDefined();
    expect(inspectPayload("get_open_invoices", 5).fatal).toBeDefined();
  });
});

describe("trace carries evidence (contract section 7)", () => {
  it("every TOOL step satisfies ToolResultSchema {tool,status,durationMs,recordCount,evidence}", async () => {
    const r = await new AgentRunner({ client: new FakeCore(baseWorld()), llm: new FakeLLM([validOutput()]), config: { toolTimeoutMs: 500, llmTimeoutMs: 500 }, clock: () => NOW }).run(REQ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tools = r.response.toolTrace.filter((s) => s.type === "TOOL");
    expect(tools.map((t) => t.tool).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(ToolResultSchema.safeParse(t).success, t.tool).toBe(true);
      expect(t.evidence).toBeDefined();
    }
    expect(tools.find((t) => t.tool === "get_open_invoices")!.evidence!.length).toBeGreaterThan(0);
    expect(r.response.toolTrace.filter((s) => s.type !== "TOOL").every((s) => s.evidence === undefined)).toBe(true);
  });
});

describe("overall request deadline in the runner", () => {
  it("model call is skipped (LLM_TIMEOUT fallback) when the deadline is nearly used up by slow tools", async () => {
    const world = baseWorld();
    const inner = new FakeCore(world);
    const slow: CoreApiClient = { get: async (p) => { await sleep(150); return inner.get(p); } };
    const llm = new FakeLLM([validOutput()]);
    const r = await new AgentRunner({ client: slow, llm, config: { toolTimeoutMs: 5000, llmTimeoutMs: 5000, totalTimeoutMs: 700 }, clock: () => NOW }).run(REQ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(llm.requests).toHaveLength(0);
    expect(r.response).toMatchObject({ status: "DEGRADED", degradedReasons: ["LLM_TIMEOUT"] });
    expect(r.response.toolTrace.some((s) => s.type === "LLM" && s.status === "SKIPPED")).toBe(true);
  });

  it("tools that start after the deadline fail with DEADLINE_EXCEEDED and the run still ends cleanly", async () => {
    const inner = new FakeCore(baseWorld());
    const slow: CoreApiClient = { get: async (p) => { await sleep(60); return inner.get(p); } };
    const r = await new AgentRunner({ client: slow, llm: new FakeLLM([validOutput()]), config: { toolTimeoutMs: 5000, llmTimeoutMs: 5000, totalTimeoutMs: 30 }, clock: () => NOW }).run(REQ);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.response.status).toBe("DEGRADED");
    expect(r.response.toolTrace.filter((s) => s.type === "TOOL" && s.errorCode === "DEADLINE_EXCEEDED")).toHaveLength(5);
  });

  it("model timeout is capped by the time left", async () => {
    const llm = new FakeLLM([validOutput()]);
    await new AgentRunner({ client: new FakeCore(baseWorld()), llm, config: { toolTimeoutMs: 500, llmTimeoutMs: 8000, totalTimeoutMs: 2000 }, clock: () => NOW }).run(REQ);
    expect(llm.requests[0]!.timeoutMs).toBeLessThanOrEqual(2000);
    const llm2 = new FakeLLM([validOutput()]);
    await new AgentRunner({ client: new FakeCore(baseWorld()), llm: llm2, config: { toolTimeoutMs: 500, llmTimeoutMs: 800, totalTimeoutMs: 30_000 }, clock: () => NOW }).run(REQ);
    expect(llm2.requests[0]!.timeoutMs).toBe(800);
  });
});
