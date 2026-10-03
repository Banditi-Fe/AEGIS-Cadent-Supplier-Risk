import { LLMError, type LLMHealth, type LLMProvider, type StructuredRequest, type StructuredResult } from "./types.js";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  numCtx: number;
  maxOutputTokens: number;
  apiKey?: string;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

function causeCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string") return e.code;
  return causeCode(e.cause);
}

/** Ollama HTTP API provider (POST /api/chat, GET /api/tags). No cloud API key is ever required. */
export class OllamaProvider implements LLMProvider {
  readonly provider = "ollama";
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: OllamaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  get model(): string {
    return this.opts.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async generateStructured(req: StructuredRequest): Promise<StructuredResult> {
    const started = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
        redirect: "error",
        body: JSON.stringify({
          model: this.opts.model,
          stream: false,
          format: req.jsonSchema,
          keep_alive: this.opts.keepAlive ?? "10m",
          options: { temperature: 0, num_ctx: this.opts.numCtx, num_predict: this.opts.maxOutputTokens },
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
      const bodyText = await res.text();
      if (!res.ok) throw this.httpError(res.status, bodyText);

      let envelope: unknown;
      try {
        envelope = JSON.parse(bodyText);
      } catch {
        throw new LLMError("TRANSIENT", "Ollama returned a non-JSON response envelope", res.status);
      }
      const env = envelope as { message?: { content?: unknown }; error?: unknown };
      if (typeof env.error === "string") throw this.httpError(res.status, JSON.stringify({ error: env.error }));
      const content = env.message?.content;
      if (typeof content !== "string") throw new LLMError("TRANSIENT", "Ollama response had no message content", res.status);

      return {
        text: content,
        provider: this.provider,
        model: this.opts.model,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if (timedOut || (err instanceof Error && err.name === "AbortError")) {
        throw new LLMError("TIMEOUT", `Ollama call exceeded ${req.timeoutMs} ms`);
      }
      const code = causeCode(err);
      if (code && UNAVAILABLE_CODES.has(code)) throw new LLMError("UNAVAILABLE", "Ollama is not reachable");
      throw new LLMError("TRANSIENT", "Ollama request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private httpError(status: number, body: string): LLMError {
    let message = "";
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error.slice(0, 200);
    } catch {
      /* body is not JSON */
    }
    if (status === 404 || /not found|try pulling/i.test(message)) {
      return new LLMError("UNAVAILABLE", "Ollama model is not installed (run: ollama pull <model>)", status);
    }
    if (status === 429 || status === 503) return new LLMError("OVERLOADED", "Ollama is overloaded", status);
    if (status >= 500) return new LLMError("TRANSIENT", `Ollama server error (HTTP ${status})`, status);
    return new LLMError("BAD_REQUEST", `Ollama rejected the request (HTTP ${status})`, status);
  }

  async health(timeoutMs = 2000): Promise<LLMHealth> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const latency = () => Math.round(performance.now() - started);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
        redirect: "error",
      });
      if (!res.ok) return { ok: false, latencyMs: latency(), detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
      const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === "string");
      const want = this.opts.model;
      const wantLatest = want.includes(":") ? want : `${want}:latest`;
      return { ok: true, latencyMs: latency(), modelAvailable: names.some((n) => n === want || n === wantLatest) };
    } catch {
      return { ok: false, latencyMs: latency(), detail: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
