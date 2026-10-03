/**
 * Minimal in-process metrics (Prometheus text format). No dependencies, no labels with free text:
 * every label value comes from a closed set (status, degraded reason, error code), so cardinality stays bounded
 * and no customer data can leak through /metrics.
 */
const LATENCY_BUCKETS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000] as const;

class Histogram {
  private readonly counts = new Array<number>(LATENCY_BUCKETS_MS.length).fill(0);
  private sum = 0;
  private total = 0;
  observe(ms: number): void {
    this.sum += ms;
    this.total += 1;
    LATENCY_BUCKETS_MS.forEach((b, i) => {
      if (ms <= b) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
  }
  render(name: string, help: string): string[] {
    const out = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
    LATENCY_BUCKETS_MS.forEach((b, i) => out.push(`${name}_bucket{le="${b}"} ${this.counts[i] ?? 0}`));
    out.push(`${name}_bucket{le="+Inf"} ${this.total}`, `${name}_sum ${this.sum}`, `${name}_count ${this.total}`);
    return out;
  }
}

export interface AnalysisObservation {
  /** COMPLETED | DEGRADED | FAILED */
  status: string;
  httpStatus: number;
  durationMs: number;
  llmLatencyMs?: number;
  llmCalls?: number;
  retries?: number;
  repairAttempted?: boolean;
  fallbackUsed?: boolean;
  toolFailures?: number;
  degradedReasons?: readonly string[];
  errorCode?: string;
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly analysisLatency = new Histogram();
  private readonly llmLatency = new Histogram();
  private inFlight = 0;

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${renderLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  setInFlight(n: number): void {
    this.inFlight = n;
  }

  observeAnalysis(o: AnalysisObservation): void {
    this.inc("aegis_ai_analyses_total", { status: o.status });
    this.analysisLatency.observe(o.durationMs);
    if (o.llmLatencyMs && o.llmLatencyMs > 0) this.llmLatency.observe(o.llmLatencyMs);
    if (o.llmCalls) this.inc("aegis_ai_llm_calls_total", {}, o.llmCalls);
    if (o.retries) this.inc("aegis_ai_llm_retries_total", {}, o.retries);
    if (o.repairAttempted) this.inc("aegis_ai_llm_repairs_total");
    if (o.fallbackUsed) this.inc("aegis_ai_fallback_total");
    if (o.toolFailures) this.inc("aegis_ai_tool_failures_total", {}, o.toolFailures);
    for (const r of o.degradedReasons ?? []) this.inc("aegis_ai_degraded_total", { reason: r });
    if (o.errorCode) this.inc("aegis_ai_errors_total", { code: o.errorCode });
  }

  /** Point-in-time snapshot used by tests and by the evaluation tooling. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  render(): string {
    const lines: string[] = [];
    const names = [...new Set([...this.counters.keys()].map((k) => k.split("{")[0] as string))].sort();
    for (const n of names) {
      lines.push(`# TYPE ${n} counter`);
      for (const [k, v] of [...this.counters.entries()].sort()) if (k === n || k.startsWith(`${n}{`)) lines.push(`${k} ${v}`);
    }
    lines.push("# TYPE aegis_ai_in_flight gauge", `aegis_ai_in_flight ${this.inFlight}`);
    lines.push(...this.analysisLatency.render("aegis_ai_analysis_duration_ms", "End-to-end analysis latency"));
    lines.push(...this.llmLatency.render("aegis_ai_llm_latency_ms", "Model latency per analysis (sum of calls)"));
    return `${lines.join("\n")}\n`;
  }
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64)}"`).join(",")}}`;
}
