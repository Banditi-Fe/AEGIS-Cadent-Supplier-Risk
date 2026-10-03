import { pino, type DestinationStream, type Logger } from "pino";

/** Header / field names that must never reach the logs. */
export const REDACT_PATHS = [
  "req.headers['x-service-key']",
  "req.headers.authorization",
  "headers['x-service-key']",
  "headers.authorization",
  "serviceKey",
  "*.serviceKey",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "password",
  "*.password",
];

export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? "info",
      name: "aegis-ai-engine",
      base: { service: "ai-engine" },
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    opts.destination,
  );
}

/** Removes known secrets from free text (error messages, URLs). */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}
