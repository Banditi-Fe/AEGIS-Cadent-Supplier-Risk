import { afterEach, describe, expect, it } from "vitest";
import { CoreApiError, HttpCoreApiClient } from "../../src/tools/index.js";
import { closedPort, json, sleep, startServer, type MockServer } from "../helpers/servers.js";

const KEY = "outbound-key-123456789012345678";
let servers: MockServer[] = [];
const start = async (h: Parameters<typeof startServer>[0]) => {
  const s = await startServer(h);
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return e instanceof CoreApiError ? e.code : `OTHER:${String(e)}`;
  }
};

describe("HttpCoreApiClient over real HTTP", () => {
  it("sends GET with the service key + correlation headers and parses JSON", async () => {
    const s = await start((_req, res) => json(res, 200, { id: "case_1" }));
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    const out = await c.get("/internal/v1/cases/case_1", { timeoutMs: 1000, requestId: "req_1", agentRunId: "run_1", organizationId: "org_1" });
    expect(out).toEqual({ id: "case_1" });
    const r = s.requests[0]!;
    expect(r.method).toBe("GET");
    expect(r.url).toBe("/internal/v1/cases/case_1");
    expect(r.headers["x-service-key"]).toBe(KEY);
    expect(r.headers["x-request-id"]).toBe("req_1");
    expect(r.headers["x-agent-run-id"]).toBe("run_1");
    expect(r.headers["x-organization-id"]).toBe("org_1");
    expect(r.body).toBe("");
  });

  it("maps HTTP statuses to error codes without leaking the body or the key", async () => {
    const s = await start((req, res) => {
      const st = Number(new URL(req.url ?? "/", "http://x").searchParams.get("s"));
      json(res, st, { secret: "customer-data-should-not-leak", key: KEY });
    });
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    const get = (st: number) => c.get(`/internal/v1/x?s=${st}`, { timeoutMs: 1000 });
    expect(await code(get(401))).toBe("UNAUTHORIZED");
    expect(await code(get(403))).toBe("UNAUTHORIZED");
    expect(await code(get(404))).toBe("NOT_FOUND");
    expect(await code(get(500))).toBe("HTTP_ERROR");
    try {
      await get(500);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("customer-data");
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });

  it("really aborts a slow response (TIMEOUT) instead of waiting for it", async () => {
    const s = await start(async (_req, res) => {
      await sleep(2000);
      json(res, 200, {});
    });
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    const t0 = performance.now();
    expect(await code(c.get("/internal/v1/slow", { timeoutMs: 150 }))).toBe("TIMEOUT");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("aborts when the body stalls after the headers (timeout covers the whole call)", async () => {
    const s = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      // never ends
    });
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    const t0 = performance.now();
    expect(await code(c.get("/internal/v1/stall", { timeoutMs: 200 }))).toBe("TIMEOUT");
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("refuses redirects: the redirect target never receives a request or the service key", async () => {
    const target = await start((_req, res) => json(res, 200, { leaked: true }));
    const origin = await start((_req, res) => {
      res.writeHead(302, { location: `${target.url}/steal` });
      res.end();
    });
    const c = new HttpCoreApiClient({ baseUrl: origin.url, serviceKey: KEY });
    expect(await code(c.get("/internal/v1/cases/case_1", { timeoutMs: 1000 }))).toBe("NETWORK");
    expect(target.requests).toHaveLength(0);
  });

  it("denies paths outside /internal/v1/ and traversal attempts WITHOUT sending any request", async () => {
    const s = await start((_req, res) => json(res, 200, {}));
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    for (const p of ["/admin/users", "/internal/v2/cases/1", "internal/v1/cases/1", "/internal/v1/../admin", "/internal/v1/%2e%2e/admin", "/internal/v1/a\\b", "//evil.example/internal/v1/x", "http://evil.example/internal/v1/x"]) {
      expect(await code(c.get(p, { timeoutMs: 500 })), p).toBe("HTTP_ERROR");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("keeps a base-URL path prefix (Core API behind /api)", async () => {
    const s = await start((_req, res) => json(res, 200, { ok: 1 }));
    const c = new HttpCoreApiClient({ baseUrl: `${s.url}/api/`, serviceKey: KEY });
    await c.get("/internal/v1/cases/case_1", { timeoutMs: 1000 });
    expect(s.requests[0]!.url).toBe("/api/internal/v1/cases/case_1");
    expect(await code(c.get("/internal/v1/../../admin", { timeoutMs: 500 }))).toBe("HTTP_ERROR");
  });

  it("invalid JSON -> INVALID_JSON, empty body -> null, oversized body -> RESPONSE_TOO_LARGE", async () => {
    const s = await start((req, res) => {
      const u = req.url ?? "";
      if (u.includes("bad")) return void res.end("<html>not json</html>");
      if (u.includes("empty")) return void res.end("");
      res.end(JSON.stringify({ pad: "x".repeat(2_100_000) }));
    });
    const c = new HttpCoreApiClient({ baseUrl: s.url, serviceKey: KEY });
    expect(await code(c.get("/internal/v1/bad", { timeoutMs: 1000 }))).toBe("INVALID_JSON");
    expect(await c.get("/internal/v1/empty", { timeoutMs: 1000 })).toBeNull();
    expect(await code(c.get("/internal/v1/big", { timeoutMs: 3000 }))).toBe("RESPONSE_TOO_LARGE");
  });

  it("unreachable Core API -> NETWORK", async () => {
    const port = await closedPort();
    const c = new HttpCoreApiClient({ baseUrl: `http://127.0.0.1:${port}`, serviceKey: KEY });
    expect(await code(c.get("/internal/v1/cases/1", { timeoutMs: 1000 }))).toBe("NETWORK");
  });
});
