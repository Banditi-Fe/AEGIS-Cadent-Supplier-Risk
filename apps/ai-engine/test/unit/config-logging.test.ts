import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { configReadiness, loadConfig } from "../../src/config/index.js";
import { createLogger, scrubSecrets } from "../../src/logging/index.js";

describe("loadConfig", () => {
  it("defaults are safe and complete; never throws on empty env", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 4100, nodeEnv: "development", totalTimeoutMs: 30000, maxConcurrentAnalyses: 4, readyRequiresOllama: false });
    expect(c.coreApi).toMatchObject({ toolTimeoutMs: 5000, serviceKeySource: "none" });
    expect(c.llm).toMatchObject({ timeoutMs: 8000, model: "llama3.1:latest", baseUrl: "http://127.0.0.1:11434", numCtx: 8192, maxOutputTokens: 900 });
    expect(c.issues).toEqual([]);
    expect(configReadiness(c)).toEqual({ config: true, coreApiUrl: false, serviceSecret: false });
  });

  it("parses overrides, trims, strips trailing slashes, accepts CORE_API_URL alias", () => {
    const c = loadConfig({ PORT: "5000", CORE_API_URL: " http://core:4000/// ", TOOL_TIMEOUT_MS: "2500", AI_REQUEST_TIMEOUT_MS: "20000", AI_TOTAL_TIMEOUT_MS: "60000", MAX_CONCURRENT_ANALYSES: "9", READY_REQUIRES_OLLAMA: "yes", LOG_LEVEL: "debug" });
    expect(c).toMatchObject({ port: 5000, totalTimeoutMs: 60000, maxConcurrentAnalyses: 9, readyRequiresOllama: true, logLevel: "debug" });
    expect(c.coreApi).toMatchObject({ baseUrl: "http://core:4000", toolTimeoutMs: 2500 });
    expect(c.llm.timeoutMs).toBe(20000);
  });

  it("reports malformed values as issues (never secrets) and falls back to defaults", () => {
    const c = loadConfig({ PORT: "abc", TOOL_TIMEOUT_MS: "5", AI_TOTAL_TIMEOUT_MS: "10", MAX_CONCURRENT_ANALYSES: "0", CORE_API_BASE_URL: "ftp://x", OLLAMA_BASE_URL: "not a url", LOG_LEVEL: "loud", READY_REQUIRES_OLLAMA: "maybe", AI_ENGINE_SHARED_SECRET: "s" });
    expect(c.port).toBe(4100);
    expect(c.coreApi.toolTimeoutMs).toBe(5000);
    expect(c.totalTimeoutMs).toBe(30000);
    expect(c.maxConcurrentAnalyses).toBe(4);
    expect(c.coreApi.baseUrl).toBeUndefined();
    expect(c.logLevel).toBe("info");
    expect(c.issues.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(c.issues)).not.toContain('"s"');
    expect(configReadiness(c).config).toBe(false);
  });

  it("production requires a >=24 char shared secret", () => {
    expect(loadConfig({ NODE_ENV: "production", AI_ENGINE_SHARED_SECRET: "short" }).issues.join(" ")).toContain("at least 24");
    expect(loadConfig({ NODE_ENV: "production", AI_ENGINE_SHARED_SECRET: "x".repeat(24) }).issues).toEqual([]);
    expect(loadConfig({ NODE_ENV: "development", AI_ENGINE_SHARED_SECRET: "short" }).issues).toEqual([]);
  });

  it("outbound key: dedicated vs shared fallback is explicit", () => {
    expect(loadConfig({ AI_ENGINE_SHARED_SECRET: "in", CORE_API_SERVICE_KEY: "out" }).coreApi).toMatchObject({ serviceKey: "out", serviceKeySource: "dedicated" });
    expect(loadConfig({ AI_ENGINE_SHARED_SECRET: "in" }).coreApi).toMatchObject({ serviceKey: "in", serviceKeySource: "shared-fallback" });
  });
});

describe("logging: secret redaction", () => {
  function capture() {
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    return { lines, logger: createLogger({ level: "info", destination: dest }) };
  }
  const SECRET = "super-secret-value-123456";

  it("redacts service key, authorization, apiKey, password and secret fields", () => {
    const { lines, logger } = capture();
    logger.info({ req: { headers: { "x-service-key": SECRET, authorization: `Bearer ${SECRET}`, accept: "json" } } }, "incoming");
    logger.info({ headers: { "x-service-key": SECRET }, serviceKey: SECRET, cfg: { apiKey: SECRET, secret: SECRET, password: SECRET, authorization: SECRET } }, "outgoing");
    const all = lines.join("");
    expect(all).not.toContain(SECRET);
    expect(all).toContain("[REDACTED]");
    expect(all).toContain('"accept":"json"'); // non-secret fields survive
  });

  it("scrubSecrets removes known secrets from free text and ignores short/undefined ones", () => {
    expect(scrubSecrets(`failed with key ${SECRET} at url`, [SECRET, undefined])).toBe("failed with key [REDACTED] at url");
    expect(scrubSecrets("abc", ["ab"])).toBe("abc");
  });
});
