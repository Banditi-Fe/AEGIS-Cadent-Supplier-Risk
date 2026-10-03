import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { OllamaProvider } from "../../src/llm/index.js";
import { createLogger } from "../../src/logging/index.js";
import { HttpCoreApiClient } from "../../src/tools/index.js";
import type { StructuredRequest } from "../../src/llm/index.js";
import { validOutput } from "../helpers/fakes.js";
import { canonicalCore, closedPort, coreHandler, json, sleep, startServer, type Handler, type MockServer } from "../helpers/servers.js";

/** Final integration test: real Fastify server -> real HttpCoreApiClient -> mock Core API, and real OllamaProvider -> mock Ollama, all over TCP. */
const SECRET = "inbound-secret-inbound-secret-123";
const CORE_KEY = "outbound-core-key-outbound-core-1";
const BODY = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "USER", userId: "u_1" } };

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((f) => f()));
  cleanup = [];
});

/** Mock Ollama that builds a valid analysis from the prompt it really receives. */
const ollamaOk: Handler = (_req, res, rec) => {
  const prompt = (JSON.parse(rec.body) as { messages: Array<{ content: string }> }).messages[1]!.content;
  json(res, 200, { message: { role: "assistant", content: validOutput()({ user: prompt } as StructuredRequest) } });
};

async function boot(opts: { core?: Handler; ollama?: Handler; env?: Record<string, string>; ollamaUrl?: string } = {}) {
  const now = new Date();
  const core: MockServer = await startServer(opts.core ?? coreHandler(now));
  const ollama: MockServer = await startServer(opts.ollama ?? ollamaOk);
  const config = loadConfig({
    NODE_ENV: "test",
    AI_ENGINE_SHARED_SECRET: SECRET,
    CORE_API_SERVICE_KEY: CORE_KEY,
    CORE_API_BASE_URL: core.url,
    OLLAMA_BASE_URL: opts.ollamaUrl ?? ollama.url,
    TOOL_TIMEOUT_MS: "1500",
    AI_REQUEST_TIMEOUT_MS: "3000",
    ...opts.env,
  });
  const app: FastifyInstance = buildApp({
    config,
    logger: createLogger({ level: "silent" }),
    llm: new OllamaProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, numCtx: config.llm.numCtx, maxOutputTokens: config.llm.maxOutputTokens }),
    client: new HttpCoreApiClient({ baseUrl: config.coreApi.baseUrl!, serviceKey: config.coreApi.serviceKey! }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as { port: number };
  cleanup.push(() => app.close(), () => core.close(), () => ollama.close());
  const analyze = (body: unknown = BODY, key: string | null = SECRET) =>
    fetch(`http://127.0.0.1:${addr.port}/v1/analyze/case`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-service-key": key } : {}) }, body: JSON.stringify(body) });
  return { core, ollama, analyze, base: `http://127.0.0.1:${addr.port}` };
}

describe("end-to-end over real HTTP", () => {
  it("COMPLETED: reads Core API (6 GETs with the OUTBOUND key), asks Ollama once, returns a validated analysis", async () => {
    const { core, ollama, analyze } = await boot();
    const res = await analyze();
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b).toMatchObject({ status: "COMPLETED", caseId: "case_1", organizationId: "org_1", customerId: "cus_1", degradedReasons: [] });
    expect(b.recommendedAction.evidenceIds.length).toBeGreaterThan(0);
    expect(b.model).toMatchObject({ provider: "ollama", status: "COMPLETED", attempt: 1 });
    expect(JSON.stringify(b)).not.toMatch(/"(AUTO|APPROVAL|BLOCKED)"/);
    expect(JSON.stringify(b)).not.toContain(SECRET);
    expect(JSON.stringify(b)).not.toContain(CORE_KEY);

    expect(core.requests).toHaveLength(6);
    for (const r of core.requests) {
      expect(r.method).toBe("GET");
      expect(r.url.startsWith("/internal/v1/")).toBe(true);
      expect(r.headers["x-service-key"]).toBe(CORE_KEY); // never the inbound secret
      expect(r.headers["x-organization-id"]).toBe("org_1");
    }
    expect(new Set(core.requests.map((r) => r.url))).toEqual(
      new Set(["/internal/v1/cases/case_1", "/internal/v1/customers/cus_1", "/internal/v1/customers/cus_1/metrics", "/internal/v1/customers/cus_1/invoices", "/internal/v1/customers/cus_1/payments", "/internal/v1/customers/cus_1/cases"]),
    );
    expect(ollama.requests).toHaveLength(1);
    // evidence in the tool trace (contract section 7) and no data-loss notes for canonical Core API payloads
    expect(b.toolTrace.filter((s: any) => s.type === "TOOL").every((s: any) => Array.isArray(s.evidence))).toBe(true);
    expect(b.uncertainties.join(" ")).not.toMatch(/deviates|ignored/);
  });

  it("canonical Core API payloads satisfy the shared contract schemas", async () => {
    const { CORE_API_RESPONSE_SCHEMAS } = await import("@aegis/contracts-ai");
    const d = canonicalCore(new Date());
    expect(CORE_API_RESPONSE_SCHEMAS.get_case.safeParse(d.case).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_customer.safeParse(d.customer).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_customer_metrics.safeParse(d.metrics).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_open_invoices.safeParse(d.invoices).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_payment_history.safeParse({ data: d.payments }).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_previous_cases.safeParse({ cases: d.cases }).success).toBe(true);
    expect(CORE_API_RESPONSE_SCHEMAS.get_open_invoices.safeParse({ nope: 1 }).success).toBe(false);
  });

  it("malformed model JSON from Ollama -> one repair over HTTP -> COMPLETED (2 model calls)", async () => {
    let n = 0;
    const { ollama, analyze } = await boot({
      ollama: (req, res, rec) => {
        n += 1;
        if (n === 1) return json(res, 200, { message: { content: '{"summary": "cut' } });
        return ollamaOk(req, res, rec);
      },
    });
    const b = (await (await analyze()).json()) as Record<string, any>;
    expect(b.status).toBe("COMPLETED");
    expect(b.model.attempt).toBe(2);
    expect(ollama.requests).toHaveLength(2);
    expect(JSON.parse(ollama.requests[1]!.body).messages[1].content).toContain("REPAIR");
  });

  it("transient Ollama 500 -> one retry -> COMPLETED; 503 twice -> DEGRADED LLM_OVERLOADED", async () => {
    let n = 0;
    const a = await boot({ ollama: (req, res, rec) => (++n === 1 ? json(res, 500, { error: "x" }) : ollamaOk(req, res, rec)) });
    expect(((await (await a.analyze()).json()) as any).status).toBe("COMPLETED");
    const b = await boot({ ollama: (_req, res) => json(res, 503, { error: "busy" }) });
    const body = (await (await b.analyze()).json()) as any;
    expect(body).toMatchObject({ status: "DEGRADED", degradedReasons: ["LLM_OVERLOADED"] });
    expect(b.ollama.requests).toHaveLength(2);
  });

  it("Ollama offline -> DEGRADED conservative fallback (never AUTO), still 200", async () => {
    const port = await closedPort();
    const { analyze } = await boot({ ollamaUrl: `http://127.0.0.1:${port}` });
    const res = await analyze();
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b).toMatchObject({ status: "DEGRADED", degradedReasons: ["LLM_UNAVAILABLE"] });
    expect(["REQUEST_HUMAN_REVIEW", "SEND_PAYMENT_REMINDER", "NO_ACTION"]).toContain(b.recommendedAction.type);
  });

  it("slow Ollama: per-call timeout -> DEGRADED LLM_TIMEOUT", async () => {
    const { analyze } = await boot({ ollama: async (_r, res) => { await sleep(1500); json(res, 200, { message: { content: "{}" } }); }, env: { AI_REQUEST_TIMEOUT_MS: "500" } });
    const t0 = performance.now();
    const b = (await (await analyze()).json()) as any;
    expect(b).toMatchObject({ status: "DEGRADED", degradedReasons: ["LLM_TIMEOUT"] });
    expect(performance.now() - t0).toBeLessThan(1400);
  });

  it("overall deadline: slow Core API + slow model never exceed AI_TOTAL_TIMEOUT_MS by much", async () => {
    const now = new Date();
    const inner = coreHandler(now);
    const { analyze } = await boot({
      core: async (req, res, rec) => { await sleep(350); return inner(req, res, rec); },
      ollama: async (req, res, rec) => { await sleep(900); return ollamaOk(req, res, rec); },
      env: { AI_TOTAL_TIMEOUT_MS: "1500", AI_REQUEST_TIMEOUT_MS: "5000", TOOL_TIMEOUT_MS: "5000" },
    });
    const t0 = performance.now();
    const res = await analyze();
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    // 2 sequential tool rounds (~700ms) leave ~800ms: the model call is capped to what is left (<900ms needed) -> DEGRADED
    expect(b.status).toBe("DEGRADED");
    expect(elapsed).toBeLessThan(2200);
  });

  it("Core API rejects the key -> 502 CORE_API_UNAUTHORIZED; unknown case -> 404; Core down -> 502", async () => {
    const a = await boot({ core: (_r, res) => json(res, 401, {}) });
    const ra = await a.analyze();
    expect(ra.status).toBe(502);
    expect(((await ra.json()) as any).error.code).toBe("CORE_API_UNAUTHORIZED");
    const b = await boot({ core: (_r, res) => json(res, 404, {}) });
    const rb = await b.analyze();
    expect(rb.status).toBe(404);
    expect(((await rb.json()) as any).error.code).toBe("CASE_NOT_FOUND");
    const port = await closedPort();
    const c = await boot({ env: { CORE_API_BASE_URL: `http://127.0.0.1:${port}` } });
    expect((await c.analyze()).status).toBe(502);
  });

  it("scope mismatch from Core API is refused (403) - the request body is not trusted", async () => {
    const now = new Date();
    const d = canonicalCore(now);
    const { analyze } = await boot({ core: coreHandler(now, { case: { ...d.case, organizationId: "org_OTHER" } }) });
    expect((await analyze()).status).toBe(403);
  });

  it("unrecognisable Core API payload is REPORTED (tool FAILED / uncertainty), not silently empty", async () => {
    const now = new Date();
    const { analyze } = await boot({ core: coreHandler(now, { invoices: [{ foo: 1 }, { bar: 2 }] as any }) });
    const b = (await (await analyze()).json()) as any;
    const step = b.toolTrace.find((s: any) => s.tool === "get_open_invoices");
    expect(step).toMatchObject({ status: "FAILED", errorCode: "INVALID_RESPONSE" });
    expect(b.uncertainties.join(" ")).toContain("get_open_invoices");
    expect(b.confidence).toBeLessThan(1);
  });

  it("auth + validation + concurrency limit", async () => {
    const now = new Date();
    const inner = coreHandler(now);
    const { analyze, base } = await boot({ core: async (r, s, c) => { await sleep(300); return inner(r, s, c); }, env: { MAX_CONCURRENT_ANALYSES: "1" } });
    expect((await analyze(BODY, "wrong")).status).toBe(401);
    expect((await analyze(BODY, null)).status).toBe(401);
    expect((await analyze({ caseId: "../x" })).status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const [r1, r2] = await Promise.all([analyze(), (async () => { await sleep(50); return analyze(); })()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 429]);
    const busy = r1.status === 429 ? r1 : r2;
    expect(busy.headers.get("retry-after")).toBe("2");
    expect(((await busy.json()) as any).error.code).toBe("SERVICE_BUSY");
    // the slot is released afterwards
    expect((await analyze()).status).toBe(200);
  });
});
