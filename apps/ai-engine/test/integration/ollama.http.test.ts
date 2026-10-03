import { afterEach, describe, expect, it } from "vitest";
import { LLMError, OllamaProvider } from "../../src/llm/index.js";
import { closedPort, json, sleep, startServer, type MockServer } from "../helpers/servers.js";

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
const provider = (baseUrl: string, extra: Partial<ConstructorParameters<typeof OllamaProvider>[0]> = {}) =>
  new OllamaProvider({ baseUrl, model: "llama3.1:latest", numCtx: 4096, maxOutputTokens: 300, ...extra });
const REQ = { system: "sys", user: "usr", jsonSchema: { type: "object" }, timeoutMs: 1000 };
const kind = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return e instanceof LLMError ? e.kind : `OTHER:${String(e)}`;
  }
};

describe("OllamaProvider over real HTTP", () => {
  it("POST /api/chat with schema-constrained, deterministic, non-streaming request", async () => {
    const s = await start((_req, res) => json(res, 200, { message: { role: "assistant", content: '{"ok":true}' } }));
    const r = await provider(s.url, { apiKey: "proxy-key-1" }).generateStructured(REQ);
    expect(r).toMatchObject({ text: '{"ok":true}', provider: "ollama", model: "llama3.1:latest" });
    const rec = s.requests[0]!;
    expect(rec.method).toBe("POST");
    expect(rec.url).toBe("/api/chat");
    expect(rec.headers.authorization).toBe("Bearer proxy-key-1");
    const body = JSON.parse(rec.body);
    expect(body).toMatchObject({ model: "llama3.1:latest", stream: false, format: { type: "object" } });
    expect(body.options).toMatchObject({ temperature: 0, num_ctx: 4096, num_predict: 300 });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("no Authorization header without an API key", async () => {
    const s = await start((_req, res) => json(res, 200, { message: { content: "{}" } }));
    await provider(s.url).generateStructured(REQ);
    expect(s.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("TIMEOUT: aborts a slow model for real, within the limit", async () => {
    const s = await start(async (_req, res) => {
      await sleep(2000);
      json(res, 200, { message: { content: "{}" } });
    });
    const t0 = performance.now();
    expect(await kind(provider(s.url).generateStructured({ ...REQ, timeoutMs: 150 }))).toBe("TIMEOUT");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("UNAVAILABLE: Ollama offline (connection refused)", async () => {
    const port = await closedPort();
    expect(await kind(provider(`http://127.0.0.1:${port}`).generateStructured(REQ))).toBe("UNAVAILABLE");
  });

  it("maps HTTP errors: 503/429 OVERLOADED, 500 TRANSIENT, 400 BAD_REQUEST, 404 model missing UNAVAILABLE", async () => {
    const s = await start((req, res) => {
      const st = Number(req.headers["x-test-status"] ?? 0);
      json(res, st, { error: st === 404 ? "model 'llama3.1' not found, try pulling it first" : "boom" });
    });
    const call = (st: number) => {
      const p = new OllamaProvider({ baseUrl: s.url, model: "m", numCtx: 1024, maxOutputTokens: 128, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-test-status": String(st) } }) });
      return kind(p.generateStructured(REQ));
    };
    expect(await call(503)).toBe("OVERLOADED");
    expect(await call(429)).toBe("OVERLOADED");
    expect(await call(500)).toBe("TRANSIENT");
    expect(await call(400)).toBe("BAD_REQUEST");
    expect(await call(404)).toBe("UNAVAILABLE");
  });

  it("retryable only for transient failures", () => {
    expect(new LLMError("TRANSIENT", "x").retryable).toBe(true);
    expect(new LLMError("OVERLOADED", "x").retryable).toBe(true);
    expect(new LLMError("TIMEOUT", "x").retryable).toBe(false);
    expect(new LLMError("UNAVAILABLE", "x").retryable).toBe(false);
  });

  it("damaged envelopes: non-JSON body, missing content, 200 with error string", async () => {
    const s = await start((req, res) => {
      const u = req.headers["x-case"];
      if (u === "html") return void res.end("<html>proxy error</html>");
      if (u === "nocontent") return json(res, 200, { message: {} });
      return json(res, 200, { error: "model 'x' not found" });
    });
    const call = (c: string) =>
      kind(new OllamaProvider({ baseUrl: s.url, model: "m", numCtx: 1024, maxOutputTokens: 128, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-case": c } }) }).generateStructured(REQ));
    expect(await call("html")).toBe("TRANSIENT");
    expect(await call("nocontent")).toBe("TRANSIENT");
    expect(await call("err")).toBe("UNAVAILABLE");
  });

  it("returns damaged model JSON as text (validation is the agent's job, not the provider's)", async () => {
    const s = await start((_req, res) => json(res, 200, { message: { content: '{"summary": "cut off' } }));
    const r = await provider(s.url).generateStructured(REQ);
    expect(r.text).toBe('{"summary": "cut off');
  });

  it("refuses redirects", async () => {
    const target = await start((_req, res) => json(res, 200, {}));
    const s = await start((_req, res) => {
      res.writeHead(307, { location: `${target.url}/api/chat` });
      res.end();
    });
    expect(await kind(provider(s.url).generateStructured(REQ))).toBe("TRANSIENT");
    expect(target.requests).toHaveLength(0);
  });

  it("health(): model installed / missing / offline / HTTP error", async () => {
    const s = await start((_req, res) => json(res, 200, { models: [{ name: "llama3.1:latest" }, { model: "qwen2.5:7b" }] }));
    expect(await provider(s.url).health()).toMatchObject({ ok: true, modelAvailable: true });
    expect(await provider(s.url, { model: "llama3.1" }).health()).toMatchObject({ ok: true, modelAvailable: true });
    expect(await provider(s.url, { model: "mistral:7b" }).health()).toMatchObject({ ok: true, modelAvailable: false });
    s.setHandler((_req, res) => json(res, 500, {}));
    expect((await provider(s.url).health()).ok).toBe(false);
    const port = await closedPort();
    expect((await provider(`http://127.0.0.1:${port}`).health()).ok).toBe(false);
  });
});
