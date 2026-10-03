import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AI_ENGINE_ROUTES, AI_SCHEMA_VERSION, AnalyzeCaseRequestSchema, SERVICE_KEY_HEADER } from "@aegis/contracts-ai";
import type { AgentRunner } from "../agent/index.js";
import { configReadiness, type AppConfig } from "../config/index.js";
import type { LLMProvider } from "../llm/index.js";
import type { Metrics } from "../metrics/index.js";
import { RateLimiter } from "../ratelimit/index.js";
import type { CoreApiClient } from "../tools/index.js";
import type { RunResult } from "../agent/index.js";
import { analyzeDisruption } from "../supply-chain/runner.js";
import { AnalyzeDisruptionRequestSchema, SUPPLY_AGENT_ROUTES } from "@aegis/contracts-ai";

export interface RouteDeps {
  config: AppConfig;
  runner: AgentRunner;
  llm: LLMProvider;
  client?: CoreApiClient;
  metrics: Metrics;
  /** Injectable for tests. */
  rateLimiter?: RateLimiter;
}

export const METRICS_ROUTE = "/metrics";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time comparison (hashes first so length does not leak). */
export function validServiceKey(provided: unknown, expected: string | undefined | readonly (string | undefined)[]): boolean {
  if (typeof provided !== "string" || provided === "") return false;
  const accepted = (Array.isArray(expected) ? expected : [expected]).filter((k): k is string => typeof k === "string" && k !== "");
  // Compare against every accepted key (no early exit) so timing does not reveal which one matched.
  let ok = false;
  for (const k of accepted) ok = timingSafeEqual(digest(provided), digest(k)) || ok;
  return ok;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, runner, llm, client, metrics } = deps;
  const limiter = deps.rateLimiter ?? new RateLimiter(config.orgRateLimitPerMinute);
  const hardDeadlineMs = config.totalTimeoutMs + config.hardDeadlineGraceMs;
  let inFlight = 0;
  /** Current key + (during rotation) the previous one. */
  const inboundKeys = [config.serviceSecret, config.serviceSecretPrevious];

  /** Public: always fast, never depends on Ollama or Core API. */
  app.get(AI_ENGINE_ROUTES.health, async () => ({ status: "ok", service: "ai-engine", schemaVersion: AI_SCHEMA_VERSION }));

  /** Public: configuration (+ Ollama / Core API when READY_REQUIRES_*). Never reveals secrets or URLs. */
  app.get(AI_ENGINE_ROUTES.ready, async (_req, reply) => {
    const c = configReadiness(config);
    const checks: Record<string, boolean> = { config: c.config, coreApiUrl: c.coreApiUrl, serviceSecret: c.serviceSecret };
    if (config.readyRequiresOllama) {
      try {
        const h = await llm.health(2000);
        checks.ollama = h.ok && h.modelAvailable !== false;
      } catch {
        checks.ollama = false;
      }
    }
    if (config.readyRequiresCoreApi) {
      try {
        checks.coreApi = client?.ping ? await client.ping(config.coreApi.healthPath, 2000) : false;
      } catch {
        checks.coreApi = false;
      }
    }
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });

  /** Internal only: Prometheus metrics, same service key as analysis. Contains counters only, never case data. */
  if (config.metricsEnabled) {
    app.get(METRICS_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
      if (!validServiceKey(req.headers[SERVICE_KEY_HEADER], inboundKeys)) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or missing service key." } });
      }
      metrics.setInFlight(inFlight);
      return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
    });
  }

  /** Internal only: Core API -> AI Engine. */
  app.post(SUPPLY_AGENT_ROUTES.analyzeDisruption, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!validServiceKey(req.headers[SERVICE_KEY_HEADER], inboundKeys)) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or missing service key." } });
    const parsed = AnalyzeDisruptionRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Request body is invalid." } });
    const rate = limiter.check(parsed.data.organizationId);
    if (!rate.allowed) return reply.code(429).header("retry-after", String(rate.retryAfterSec)).send({ error: { code: "SERVICE_BUSY", message: "Rate limit reached; retry after the indicated delay." } });
    if (inFlight >= config.maxConcurrentAnalyses) return reply.code(429).header("retry-after", "2").send({ error: { code: "SERVICE_BUSY", message: "Too many analyses are running; retry shortly." } });
    inFlight += 1;
    try {
      const result = await analyzeDisruption(parsed.data, { config, client, llm, requestId: req.id });
      return reply.code(200).send(result);
    } catch (err) {
      req.log.warn({ errName: err instanceof Error ? err.name : "UnknownError" }, "supply-chain analysis failed");
      return reply.code(503).send({ error: { code: "ANALYSIS_UNAVAILABLE", message: "Disruption analysis is unavailable; Core API should use its deterministic fallback." } });
    } finally {
      inFlight -= 1;
    }
  });

  /** Legacy payment analysis retained temporarily for backwards compatibility. */
  app.post(AI_ENGINE_ROUTES.analyzeCase, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!validServiceKey(req.headers[SERVICE_KEY_HEADER], inboundKeys)) {
      metrics.inc("aegis_ai_errors_total", { code: "UNAUTHORIZED" });
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or missing service key." } });
    }
    const parsed = AnalyzeCaseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Request body is invalid.", details: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    // Per-organization limit: one noisy tenant cannot starve the others (and cannot flood Ollama).
    const rate = limiter.check(parsed.data.organizationId);
    if (!rate.allowed) {
      metrics.inc("aegis_ai_rejected_total", { reason: "org_rate_limit" });
      return reply
        .code(429)
        .header("retry-after", String(rate.retryAfterSec))
        .send({ error: { code: "SERVICE_BUSY", message: "Rate limit for this organization reached; retry after the indicated delay." } });
    }
    // Global cap protects Ollama / Core API: no queueing, the caller (Core API) decides when to retry.
    if (inFlight >= config.maxConcurrentAnalyses) {
      metrics.inc("aegis_ai_rejected_total", { reason: "concurrency" });
      return reply
        .code(429)
        .header("retry-after", "2")
        .send({ error: { code: "SERVICE_BUSY", message: "Too many analyses are running; retry shortly." } });
    }
    inFlight += 1;
    const t0 = performance.now();
    // The slot is released when the work REALLY ends (not when the hard deadline answers), so a stuck run keeps counting.
    const work: Promise<RunResult> = runner.run(parsed.data, { requestId: req.id });
    work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      inFlight -= 1;
    });
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<"HARD_TIMEOUT">((resolve) => {
      timer = setTimeout(() => resolve("HARD_TIMEOUT"), hardDeadlineMs);
    });
    try {
      const winner = await Promise.race([work, guard]);
      const durationMs = Math.round(performance.now() - t0);
      if (winner === "HARD_TIMEOUT") {
        req.log.error({ hardDeadlineMs }, "analysis exceeded the hard deadline");
        metrics.observeAnalysis({ status: "FAILED", httpStatus: 504, durationMs, errorCode: "ANALYSIS_TIMEOUT" });
        // Same shape as every other analysis failure (AnalyzeCaseErrorSchema).
        return reply.code(504).send({ schemaVersion: AI_SCHEMA_VERSION, status: "FAILED", caseId: parsed.data.caseId, error: { code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded the overall time limit." } });
      }
      if (winner.ok) {
        metrics.observeAnalysis({
          status: winner.response.status,
          httpStatus: 200,
          durationMs,
          llmLatencyMs: winner.response.model.latencyMs,
          llmCalls: winner.diagnostics.llmCalls,
          retries: winner.diagnostics.retries,
          repairAttempted: winner.diagnostics.repairAttempted,
          fallbackUsed: winner.diagnostics.fallbackUsed,
          toolFailures: winner.diagnostics.toolFailures,
          degradedReasons: winner.response.degradedReasons,
        });
        return reply.code(winner.httpStatus).send(winner.response);
      }
      metrics.observeAnalysis({ status: "FAILED", httpStatus: winner.httpStatus, durationMs, toolFailures: winner.diagnostics.toolFailures, errorCode: winner.error.error.code });
      return reply.code(winner.httpStatus).send(winner.error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
