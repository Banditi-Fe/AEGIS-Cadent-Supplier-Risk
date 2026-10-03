import { buildApp } from "./app.js";
import { configReadiness, loadConfig } from "./config/index.js";
import { OllamaProvider } from "./llm/index.js";
import { createLogger } from "./logging/index.js";
import { HttpCoreApiClient, UnconfiguredCoreApiClient } from "./tools/index.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

const llm = new OllamaProvider({
  baseUrl: config.llm.baseUrl,
  model: config.llm.model,
  numCtx: config.llm.numCtx,
  maxOutputTokens: config.llm.maxOutputTokens,
  apiKey: config.llm.apiKey,
});
const client =
  config.coreApi.baseUrl && config.coreApi.serviceKey
    ? new HttpCoreApiClient({ baseUrl: config.coreApi.baseUrl, serviceKey: config.coreApi.serviceKey })
    : new UnconfiguredCoreApiClient();

const app = buildApp({ config, logger, llm, client });

const r = configReadiness(config);
if (!r.serviceSecret) logger.warn("AI_ENGINE_SHARED_SECRET is not set: /v1/analyze/case will reject every request");
if (!r.coreApiUrl) logger.warn("CORE_API_BASE_URL is not set: Core API tools will fail");
if (config.coreApi.serviceKeySource === "shared-fallback") {
  logger.warn("CORE_API_SERVICE_KEY is not set: the inbound AI_ENGINE_SHARED_SECRET is reused as outbound key. Use two different secrets in production.");
}
for (const issue of config.issues) logger.warn({ issue }, "configuration issue");

const shutdown = (signal: string): void => {
  logger.info({ signal }, "shutting down");
  app.close().finally(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen({ host: config.host, port: config.port }).catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : "listen failed" }, "failed to start");
  process.exit(1);
});
