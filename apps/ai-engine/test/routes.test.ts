import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";
import { createLogger } from "../src/logging/index.js";
import { FakeCore, FakeLLM, NOW, baseWorld, validOutput } from "./helpers/fakes.js";

const SECRET = "test-secret-test-secret-123456";
const BODY = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "USER", userId: "u_1" } };

function app(env: Record<string, string> = {}) {
  const config = loadConfig({ AI_ENGINE_SHARED_SECRET: SECRET, CORE_API_BASE_URL: "http://core.local", NODE_ENV: "test", ...env });
  return buildApp({ config, logger: createLogger({ level: "silent" }), llm: new FakeLLM([validOutput()]), client: new FakeCore(baseWorld()), clock: () => NOW });
}
const post = (a: ReturnType<typeof app>, headers: Record<string, string>, payload: unknown = BODY) =>
  a.inject({ method: "POST", url: "/v1/analyze/case", headers, payload: payload as object });

describe("routes", () => {
  it("GET /health is public and fast", async () => {
    const r = await app().inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("GET /ready: ready when configured, 503 when secret missing, no secrets leaked", async () => {
    expect((await app().inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const bad = await app({ AI_ENGINE_SHARED_SECRET: "" }).inject({ method: "GET", url: "/ready" });
    expect(bad.statusCode).toBe(503);
    expect(bad.body).not.toContain(SECRET);
  });

  it("rejects missing / wrong service key", async () => {
    const a = app();
    expect((await post(a, {})).statusCode).toBe(401);
    expect((await post(a, { "x-service-key": "wrong" })).statusCode).toBe(401);
  });

  it("rejects everything when the server has no secret configured", async () => {
    const r = await post(app({ AI_ENGINE_SHARED_SECRET: "" }), { "x-service-key": "" });
    expect(r.statusCode).toBe(401);
  });

  it("validates the body", async () => {
    const r = await post(app(), { "x-service-key": SECRET }, { caseId: "../etc/passwd" });
    expect(r.statusCode).toBe(400);
  });

  it("valid request returns a structured analysis without an AUTO/APPROVAL/BLOCKED decision", async () => {
    const r = await post(app(), { "x-service-key": SECRET });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ schemaVersion: "1.0", caseId: "case_1", status: "COMPLETED" });
    expect(b.toolTrace.length).toBeGreaterThan(5);
    expect(r.body).not.toMatch(/"(AUTO|APPROVAL|BLOCKED)"/);
    expect(r.body).not.toContain(SECRET);
  });

  it("unknown route -> 404, other methods on analyze -> not 200", async () => {
    const a = app();
    expect((await a.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/v1/analyze/case" })).statusCode).toBe(404);
  });
});
