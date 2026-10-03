import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { AgentRunner } from "./agent/index.js";
import type { AppConfig } from "./config/index.js";
import type { LLMProvider } from "./llm/index.js";
import { Metrics } from "./metrics/index.js";
import { registerRoutes } from "./routes/index.js";
import type { CoreApiClient } from "./tools/index.js";

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  llm: LLMProvider;
  client: CoreApiClient;
  clock?: () => Date;
  metrics?: Metrics;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config, logger, llm, client } = deps;
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 16 * 1024,
    // Time allowed to RECEIVE a request / idle connection; the analysis itself is bounded by totalTimeoutMs in the runner.
    requestTimeout: 15_000,
    connectionTimeout: 0,
    keepAliveTimeout: 5_000,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  }) as unknown as FastifyInstance;
  const runner = new AgentRunner({
    client,
    llm,
    logger,
    clock: deps.clock,
    config: { toolTimeoutMs: config.coreApi.toolTimeoutMs, llmTimeoutMs: config.llm.timeoutMs, totalTimeoutMs: config.totalTimeoutMs, maxRetries: config.maxRetries, maxRepairs: config.maxRepairs },
  });
  registerRoutes(app, { config, runner, llm, client, metrics: deps.metrics ?? new Metrics() });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found." } }));
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ errName: err.name }, "unhandled error");
    return reply.code(status).send({ error: { code: status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST", message: status === 500 ? "Internal error." : "Invalid request." } });
  });
  return app;
}
