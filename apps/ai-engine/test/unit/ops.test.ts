import { describe, expect, it } from "vitest";
import { AgentRunner } from "../../src/agent/index.js";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { LLMError } from "../../src/llm/index.js";
import { createLogger } from "../../src/logging/index.js";
import { Metrics } from "../../src/metrics/index.js";
import { RateLimiter } from "../../src/ratelimit/index.js";
import { validServiceKey } from "../../src/routes/index.js";
import type { CoreApiClient } from "../../src/tools/index.js";
import { FakeCore, FakeLLM, NOW, baseWorld, validOutput } from "../helpers/fakes.js";

const REQ = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "USER" as const, userId: "u_1" } };
const SECRET = "test-secret-test-secret-123456";
const OLD = "old-secret-old-secret-old-12345";

describe("retry + repair budgets are independent (up to 3 model calls)", () => {
  it("transient failure -> retry -> invalid output -> repair -> COMPLETED (3 calls)", async () => {
    const llm = new FakeLLM([new LLMError("TRANSIENT", "boom"), "not json", validOutput()]);
    const r = await new AgentRunner({ client: new FakeCore(baseWorld()), llm, config: { toolTimeoutMs: 1000, llmTimeoutMs: 1000 }, clock: () => NOW }).run(REQ);
    expect(r.ok && r.response.status).toBe("COMPLETED");
    expect(llm.requests).toHaveLength(3);
    if (r.ok) expect(r.diagnostics).toMatchObject({ retries: 1, repairAttempted: true, repairSucceeded: true, llmCalls: 3 });
  });

  it("never exceeds 3 calls: second invalid output -> fallback (no second repair)", async () => {
    const llm = new FakeLLM(["not json"]);
    const r = await new AgentRunner({ client: new FakeCore(baseWorld()), llm, config: { toolTimeoutMs: 1000, llmTimeoutMs: 1000 }, clock: () => NOW }).run(REQ);
    expect(r.ok && r.response.status).toBe("DEGRADED");
    expect(llm.requests).toHaveLength(2); // 1 normal + 1 repair
  });

  it("two transient failures with maxRetries=1 -> 2 calls then fallback", async () => {
    const llm = new FakeLLM([new LLMError("OVERLOADED", "busy")]);
    const r = await new AgentRunner({ client: new FakeCore(baseWorld()), llm, config: { toolTimeoutMs: 1000, llmTimeoutMs: 1000 }, clock: () => NOW }).run(REQ);
    expect(r.ok && r.response.status).toBe("DEGRADED");
    expect(llm.requests).toHaveLength(2);
  });

  it("maxRetries=0 / maxRepairs=0 restore single-shot behaviour", async () => {
    const llm = new FakeLLM(["not json", validOutput()]);
    const r = await new AgentRunner({ client: new FakeCore(baseWorld()), llm, config: { toolTimeoutMs: 1000, llmTimeoutMs: 1000, maxRetries: 0, maxRepairs: 0 }, clock: () => NOW }).run(REQ);
    expect(r.ok && r.response.status).toBe("DEGRADED");
    expect(llm.requests).toHaveLength(1);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit per key, then reports Retry-After, then resets", () => {
    let t = 1_000_000;
    const l = new RateLimiter(2, 60_000, () => t);
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("a").allowed).toBe(true);
    const d = l.check("a");
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(d.retryAfterSec).toBeLessThanOrEqual(60);
    expect(l.check("b").allowed).toBe(true); // other tenants unaffected
    t += 60_001;
    expect(l.check("a").allowed).toBe(true);
  });
  it("limit 0 disables it; key flooding stays bounded", () => {
    expect(new RateLimiter(0).check("x").allowed).toBe(true);
    const l = new RateLimiter(5, 60_000, () => 1, 10);
    for (let i = 0; i < 100; i++) l.check(`k${i}`);
    expect(l.check("k0").allowed).toBe(true);
  });
});

describe("key rotation", () => {
  it("accepts current and previous inbound key, rejects everything else", () => {
    expect(validServiceKey(SECRET, [SECRET, OLD])).toBe(true);
    expect(validServiceKey(OLD, [SECRET, OLD])).toBe(true);
    expect(validServiceKey("nope", [SECRET, OLD])).toBe(false);
    expect(validServiceKey(undefined, [SECRET, OLD])).toBe(false);
    expect(validServiceKey(SECRET, [undefined, undefined])).toBe(false);
    expect(validServiceKey(SECRET, SECRET)).toBe(true);
  });
  it("config rejects a previous key equal to the current one", () => {
    expect(loadConfig({ AI_ENGINE_SHARED_SECRET: SECRET, AI_ENGINE_SHARED_SECRET_PREVIOUS: SECRET }).issues.join(" ")).toContain("PREVIOUS");
  });
});

describe("config (ops settings)", () => {
  it("has safe defaults and validates ranges", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ maxRetries: 1, maxRepairs: 1, orgRateLimitPerMinute: 30, hardDeadlineGraceMs: 2000, readyRequiresCoreApi: false, metricsEnabled: true });
    expect(c.coreApi.healthPath).toBe("/internal/v1/health");
    expect(loadConfig({ AI_MAX_RETRIES: "9" }).issues.join(" ")).toContain("AI_MAX_RETRIES");
    expect(loadConfig({ CORE_API_HEALTH_PATH: "/admin" }).issues.join(" ")).toContain("CORE_API_HEALTH_PATH");
  });
});

describe("Metrics", () => {
  it("renders counters, gauges and histograms with bounded labels", () => {
    const m = new Metrics();
    m.observeAnalysis({ status: "DEGRADED", httpStatus: 200, durationMs: 900, llmLatencyMs: 700, llmCalls: 2, retries: 1, repairAttempted: true, fallbackUsed: true, degradedReasons: ["LLM_TIMEOUT"], toolFailures: 1 });
    m.observeAnalysis({ status: "COMPLETED", httpStatus: 200, durationMs: 300, llmCalls: 1 });
    m.inc("aegis_ai_errors_total", { code: 'bad"label\n{x}' });
    const out = m.render();
    expect(out).toContain('aegis_ai_analyses_total{status="DEGRADED"} 1');
    expect(out).toContain('aegis_ai_analyses_total{status="COMPLETED"} 1');
    expect(out).toContain("aegis_ai_fallback_total 1");
    expect(out).toContain('aegis_ai_degraded_total{reason="LLM_TIMEOUT"} 1');
    expect(out).toContain("aegis_ai_analysis_duration_ms_count 2");
    expect(out).not.toMatch(/bad"label/);
  });
});

function app(env: Record<string, string> = {}, client: CoreApiClient = new FakeCore(baseWorld()), llm = new FakeLLM([validOutput()])) {
  const config = loadConfig({ AI_ENGINE_SHARED_SECRET: SECRET, CORE_API_BASE_URL: "http://core.local", NODE_ENV: "test", ...env });
  return buildApp({ config, logger: createLogger({ level: "silent" }), llm, client, clock: () => NOW });
}
const post = (a: ReturnType<typeof app>, key = SECRET, payload: unknown = REQ) =>
  a.inject({ method: "POST", url: "/v1/analyze/case", headers: { "x-service-key": key }, payload: payload as object });

describe("routes (ops)", () => {
  it("/metrics requires the service key and exposes analysis counters", async () => {
    const a = app();
    expect((await a.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await post(a)).statusCode).toBe(200);
    const r = await a.inject({ method: "GET", url: "/metrics", headers: { "x-service-key": SECRET } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('aegis_ai_analyses_total{status="COMPLETED"} 1');
    expect(r.body).not.toContain("org_1");
  });

  it("/metrics can be disabled", async () => {
    expect((await app({ METRICS_ENABLED: "false" }).inject({ method: "GET", url: "/metrics", headers: { "x-service-key": SECRET } })).statusCode).toBe(404);
  });

  it("previous inbound key works during rotation", async () => {
    const a = app({ AI_ENGINE_SHARED_SECRET_PREVIOUS: OLD });
    expect((await post(a, OLD)).statusCode).toBe(200);
    expect((await post(a, "wrong")).statusCode).toBe(401);
  });

  it("per-organization rate limit -> 429 SERVICE_BUSY with Retry-After; other org unaffected", async () => {
    const a = app({ ORG_RATE_LIMIT_PER_MINUTE: "2" });
    expect((await post(a)).statusCode).toBe(200);
    expect((await post(a)).statusCode).toBe(200);
    const r = await post(a);
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.json().error.code).toBe("SERVICE_BUSY");
  });

  it("/ready probes Core API only when READY_REQUIRES_CORE_API=true", async () => {
    const up: CoreApiClient = { get: async () => null, ping: async () => true };
    const down: CoreApiClient = { get: async () => null, ping: async () => false };
    const noPing: CoreApiClient = { get: async () => null };
    expect((await app({}, down).inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const ok = await app({ READY_REQUIRES_CORE_API: "true" }, up).inject({ method: "GET", url: "/ready" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().checks.coreApi).toBe(true);
    const bad = await app({ READY_REQUIRES_CORE_API: "true" }, down).inject({ method: "GET", url: "/ready" });
    expect(bad.statusCode).toBe(503);
    expect(bad.json().checks.coreApi).toBe(false);
    expect((await app({ READY_REQUIRES_CORE_API: "true" }, noPing).inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
  });

  it("hard deadline: a call that ignores the deadline still gets HTTP 504 ANALYSIS_TIMEOUT", async () => {
    const stuck: CoreApiClient = { get: () => new Promise(() => undefined) }; // never settles, ignores timeouts
    const a = app({ AI_TOTAL_TIMEOUT_MS: "1000", AI_HARD_DEADLINE_GRACE_MS: "0" }, stuck);
    const t0 = Date.now();
    const r = await post(a);
    expect(r.statusCode).toBe(504);
    expect(r.json().error.code).toBe("ANALYSIS_TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
