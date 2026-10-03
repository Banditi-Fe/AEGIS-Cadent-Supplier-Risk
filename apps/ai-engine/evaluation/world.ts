import { CoreApiError, type CoreApiClient } from "../src/tools/index.js";

export const EVAL_NOW = new Date("2026-10-03T10:00:00Z");
export const daysAgo = (n: number): string => new Date(EVAL_NOW.getTime() - n * 86_400_000).toISOString();

export type Part = "case" | "customer" | "metrics" | "invoices" | "payments" | "cases";
export interface World {
  case: unknown;
  customer: unknown;
  metrics: unknown;
  invoices: unknown;
  payments: unknown;
  cases: unknown;
  fail?: Partial<Record<Part, CoreApiError>>;
}

/** In-memory read-only Core API. Records every requested path. */
export class InMemoryCore implements CoreApiClient {
  readonly calls: string[] = [];
  constructor(private readonly w: World) {}
  async get(path: string): Promise<unknown> {
    this.calls.push(path);
    const key: Part = path.endsWith("/metrics") ? "metrics" : path.endsWith("/invoices") ? "invoices" : path.endsWith("/payments") ? "payments" : path.endsWith("/cases") ? "cases" : path.includes("/cases/") ? "case" : "customer";
    const err = this.w.fail?.[key];
    if (err) throw err;
    return this.w[key];
  }
}
