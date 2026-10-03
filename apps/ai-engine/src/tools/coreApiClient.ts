/**
 * Read-only HTTP client for the Core API internal endpoints.
 * - Only GET exists on purpose (the AI Engine can never mutate business data).
 * - Always sends X-Service-Key, enforces a timeout, refuses redirects (no key leakage).
 * - Errors never contain response bodies (they may hold customer data) or the service key.
 */
export type CoreApiErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "HTTP_ERROR"
  | "INVALID_JSON"
  | "RESPONSE_TOO_LARGE"
  | "NOT_CONFIGURED";

export class CoreApiError extends Error {
  constructor(
    readonly code: CoreApiErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

export interface CoreApiRequestOptions {
  timeoutMs: number;
  requestId?: string;
  agentRunId?: string;
  organizationId?: string;
}

export interface CoreApiClient {
  get(path: string, opts: CoreApiRequestOptions): Promise<unknown>;
  /**
   * Optional reachability probe for /ready (read-only GET on a health path under /internal/v1/).
   * Resolves true when Core API answered 2xx; never throws.
   */
  ping?(path: string, timeoutMs: number): Promise<boolean>;
}

const MAX_BODY_CHARS = 2_000_000;

export class HttpCoreApiClient implements CoreApiClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly allowedPrefix: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: { baseUrl: string; serviceKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    const base = new URL(this.baseUrl);
    this.baseOrigin = base.origin;
    this.allowedPrefix = `${base.pathname.replace(/\/+$/, "")}/internal/v1/`;
    this.serviceKey = cfg.serviceKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /**
   * Builds the final URL and proves it stays on the Core API origin, under <base>/internal/v1/.
   * A plain startsWith("/internal/v1/") is NOT enough: "/internal/v1/../admin" is normalised by the URL parser.
   */
  private resolve(path: string): string {
    const denied = (): CoreApiError => new CoreApiError("HTTP_ERROR", "Only /internal/v1/* read endpoints may be called");
    // eslint-disable-next-line no-control-regex
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001F\u007F]/.test(path) || /%2e|%2f|%5c/i.test(path)) throw denied();
    let url: URL;
    try {
      url = new URL(`${this.baseUrl}${path}`);
    } catch {
      throw denied();
    }
    if (url.origin !== this.baseOrigin || !url.pathname.startsWith(this.allowedPrefix) || url.pathname.split("/").some((seg) => seg === "." || seg === "..")) throw denied();
    return url.toString();
  }

  async ping(path: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.get(path, { timeoutMs });
      return true;
    } catch (err) {
      // A 404 means "Core API is up but has no health endpoint": reachable, and the key was accepted.
      return err instanceof CoreApiError && err.code === "NOT_FOUND";
    }
  }

  async get(path: string, opts: CoreApiRequestOptions): Promise<unknown> {
    const target = this.resolve(path);
    const headers: Record<string, string> = {
      "x-service-key": this.serviceKey,
      accept: "application/json",
      "user-agent": "aegis-ai-engine/1.0",
    };
    if (opts.requestId) headers["x-request-id"] = opts.requestId;
    if (opts.agentRunId) headers["x-agent-run-id"] = opts.agentRunId;
    if (opts.organizationId) headers["x-organization-id"] = opts.organizationId;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);

    try {
      const res = await this.fetchImpl(target, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (res.status === 401 || res.status === 403) {
        throw new CoreApiError("UNAUTHORIZED", "Core API rejected the service key", res.status);
      }
      if (res.status === 404) throw new CoreApiError("NOT_FOUND", "Core API resource not found", 404);
      if (!res.ok) throw new CoreApiError("HTTP_ERROR", `Core API responded with HTTP ${res.status}`, res.status);

      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) {
        throw new CoreApiError("RESPONSE_TOO_LARGE", "Core API response exceeded the size limit", res.status);
      }
      if (text.trim() === "") return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new CoreApiError("INVALID_JSON", "Core API returned invalid JSON", res.status);
      }
    } catch (err) {
      if (err instanceof CoreApiError) throw err;
      if (timedOut || (err instanceof Error && err.name === "AbortError")) {
        throw new CoreApiError("TIMEOUT", `Core API call exceeded ${opts.timeoutMs} ms`);
      }
      throw new CoreApiError("NETWORK", "Core API is unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Used when CORE_API_BASE_URL / key are missing: every call fails fast, nothing is fabricated. */
export class UnconfiguredCoreApiClient implements CoreApiClient {
  get(): Promise<unknown> {
    return Promise.reject(new CoreApiError("NOT_CONFIGURED", "Core API URL or service key is not configured"));
  }
}
