export type LLMErrorKind = "UNAVAILABLE" | "TIMEOUT" | "OVERLOADED" | "TRANSIENT" | "BAD_REQUEST";

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
  /** Only transient failures are retried. Timeouts and "offline" are NOT retried (strict latency). */
  get retryable(): boolean {
    return this.kind === "OVERLOADED" || this.kind === "TRANSIENT";
  }
}

export interface StructuredRequest {
  system: string;
  user: string;
  /** JSON Schema the provider should constrain its output to. */
  jsonSchema: Record<string, unknown>;
  /** Strict per-call timeout. The request is aborted when exceeded. */
  timeoutMs: number;
}

export interface StructuredResult {
  /** Raw model text (expected to be a JSON document). Validation happens in the agent, not here. */
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LLMHealth {
  ok: boolean;
  latencyMs: number;
  /** true when the configured model is installed (when the provider can tell). */
  modelAvailable?: boolean;
  detail?: string;
}

/** The engine depends on this interface, never on a concrete model. */
export interface LLMProvider {
  readonly provider: string;
  readonly model: string;
  generateStructured(req: StructuredRequest): Promise<StructuredResult>;
  health(timeoutMs?: number): Promise<LLMHealth>;
}
