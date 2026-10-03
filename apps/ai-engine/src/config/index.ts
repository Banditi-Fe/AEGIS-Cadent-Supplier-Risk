/**
 * Environment configuration. Never throws on missing values: /health must always work and
 * /ready reports what is missing. Malformed values are collected in `issues`.
 */
export const HARD_MAX_TOOL_CALLS = 6 as const;

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: LogLevel;
  /** Inbound secret (Core API -> AI Engine). */
  serviceSecret?: string;
  /** Previous inbound secret, accepted during key rotation only (AI_ENGINE_SHARED_SECRET_PREVIOUS). */
  serviceSecretPrevious?: string;
  coreApi: {
    baseUrl?: string;
    serviceKey?: string;
    /** "dedicated" = CORE_API_SERVICE_KEY, "shared-fallback" = reuses AI_ENGINE_SHARED_SECRET */
    serviceKeySource: "dedicated" | "shared-fallback" | "none";
    toolTimeoutMs: number;
    /** Read-only probe used by /ready when READY_REQUIRES_CORE_API=true. */
    healthPath: string;
  };
  /** Overall deadline of ONE analysis (tools + model calls). */
  totalTimeoutMs: number;
  /** Max analyses running at the same time; extra requests get HTTP 429. */
  maxConcurrentAnalyses: number;
  /** Extra time on top of totalTimeoutMs before the route gives up and answers 504 (hard guard). */
  hardDeadlineGraceMs: number;
  /** Per-organization limit (analyses per minute); 0 disables it. Excess requests get HTTP 429 SERVICE_BUSY. */
  orgRateLimitPerMinute: number;
  /** Max model calls = 1 + maxRetries + maxRepairs. */
  maxRetries: number;
  maxRepairs: number;
  llm: {
    provider: "ollama";
    model: string;
    baseUrl: string;
    timeoutMs: number;
    numCtx: number;
    maxOutputTokens: number;
    apiKey?: string;
  };
  readyRequiresOllama: boolean;
  readyRequiresCoreApi: boolean;
  /** Prometheus text endpoint /metrics (protected by the service key). */
  metricsEnabled: boolean;
  /** Problems found while parsing the environment (reported by /ready, never contains secrets). */
  issues: string[];
}

const LOG_LEVELS: LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const str = (key: string): string | undefined => {
    const v = env[key];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };
  const int = (key: string, def: number, min: number, max: number): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      issues.push(`${key} must be an integer between ${min} and ${max}`);
      return def;
    }
    return n;
  };
  const bool = (key: string, def: boolean): boolean => {
    const raw = str(key)?.toLowerCase();
    if (raw === undefined) return def;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    issues.push(`${key} must be a boolean`);
    return def;
  };
  const url = (key: string, alt?: string): string | undefined => {
    const raw = str(key) ?? (alt ? str(alt) : undefined);
    if (raw === undefined) return undefined;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      return u.toString().replace(/\/+$/, "");
    } catch {
      issues.push(`${key} is not a valid http(s) URL`);
      return undefined;
    }
  };

  const nodeEnvRaw = str("NODE_ENV");
  const nodeEnv = nodeEnvRaw === "production" || nodeEnvRaw === "test" ? nodeEnvRaw : "development";
  const logRaw = str("LOG_LEVEL");
  const logLevel: LogLevel = logRaw && (LOG_LEVELS as string[]).includes(logRaw) ? (logRaw as LogLevel) : "info";
  if (logRaw && !(LOG_LEVELS as string[]).includes(logRaw)) issues.push("LOG_LEVEL is not a valid level");

  const serviceSecret = str("AI_ENGINE_SHARED_SECRET");
  if (serviceSecret && nodeEnv === "production" && serviceSecret.length < 24) {
    issues.push("AI_ENGINE_SHARED_SECRET must be at least 24 characters in production");
  }

  const serviceSecretPrevious = str("AI_ENGINE_SHARED_SECRET_PREVIOUS");
  if (serviceSecretPrevious && serviceSecretPrevious === serviceSecret) {
    issues.push("AI_ENGINE_SHARED_SECRET_PREVIOUS must differ from AI_ENGINE_SHARED_SECRET");
  }
  const healthPath = str("CORE_API_HEALTH_PATH") ?? "/internal/v1/health";
  if (!healthPath.startsWith("/internal/v1/")) issues.push("CORE_API_HEALTH_PATH must start with /internal/v1/");

  return {
    nodeEnv,
    host: str("HOST") ?? "127.0.0.1",
    port: int("PORT", 4100, 1, 65535),
    logLevel,
    serviceSecret,
    serviceSecretPrevious,
    coreApi: {
      baseUrl: url("CORE_API_BASE_URL", "CORE_API_URL"),
      serviceKey: str("CORE_API_SERVICE_KEY") ?? serviceSecret,
      serviceKeySource: str("CORE_API_SERVICE_KEY") ? "dedicated" : serviceSecret ? "shared-fallback" : "none",
      toolTimeoutMs: int("TOOL_TIMEOUT_MS", 5000, 100, 60000),
      healthPath: healthPath.startsWith("/internal/v1/") ? healthPath : "/internal/v1/health",
    },
    totalTimeoutMs: int("AI_TOTAL_TIMEOUT_MS", 30000, 1000, 600000),
    maxConcurrentAnalyses: int("MAX_CONCURRENT_ANALYSES", 4, 1, 100),
    hardDeadlineGraceMs: int("AI_HARD_DEADLINE_GRACE_MS", 2000, 0, 60000),
    orgRateLimitPerMinute: int("ORG_RATE_LIMIT_PER_MINUTE", 30, 0, 100000),
    maxRetries: int("AI_MAX_RETRIES", 1, 0, 3),
    maxRepairs: int("AI_MAX_REPAIRS", 1, 0, 3),
    llm: {
      provider: "ollama",
      model: str("OLLAMA_MODEL") ?? "llama3.1:latest",
      baseUrl: url("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434",
      timeoutMs: int("AI_REQUEST_TIMEOUT_MS", 8000, 500, 120000),
      numCtx: int("OLLAMA_NUM_CTX", 8192, 1024, 131072),
      maxOutputTokens: int("OLLAMA_MAX_OUTPUT_TOKENS", 900, 128, 8192),
      apiKey: str("OLLAMA_API_KEY"),
    },
    readyRequiresOllama: bool("READY_REQUIRES_OLLAMA", false),
    readyRequiresCoreApi: bool("READY_REQUIRES_CORE_API", false),
    metricsEnabled: bool("METRICS_ENABLED", true),
    issues,
  };
}

export interface ConfigReadiness {
  config: boolean;
  coreApiUrl: boolean;
  serviceSecret: boolean;
}

export function configReadiness(config: AppConfig): ConfigReadiness {
  return {
    config: config.issues.length === 0,
    coreApiUrl: Boolean(config.coreApi.baseUrl),
    serviceSecret: Boolean(config.serviceSecret),
  };
}
