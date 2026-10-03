/**
 * Measures REAL model latency (Ollama on this machine) against growing evidence sizes and recommends
 * AI_REQUEST_TIMEOUT_MS / AI_TOTAL_TIMEOUT_MS. Needs a running Ollama:
 *     ollama pull llama3.1 && pnpm measure:latency            (RUNS=5 SIZES=5,25,100,200 to tune)
 * Nothing here talks to Core API: worlds are generated in memory, so it measures the model only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../src/agent/index.js";
import { loadConfig } from "../src/config/index.js";
import { OllamaProvider } from "../src/llm/index.js";
import { createLogger } from "../src/logging/index.js";
import { EVAL_NOW, InMemoryCore, daysAgo, type World } from "./world.js";

const config = loadConfig();
const RUNS = Number(process.env.RUNS ?? 5);
const SIZES = (process.env.SIZES ?? "5,25,100,200").split(",").map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0);
const GENEROUS_MS = 180_000; // measure first, constrain later

function syntheticWorld(rows: number): World {
  const invoices = Array.from({ length: rows }, (_, i) => ({ id: `inv_${i + 1}`, number: `INV-${i + 1}`, amount: 400 + (i % 7) * 150, status: "OPEN", dueDate: daysAgo(5 + (i % 90)), currency: "EUR" }));
  const payments = Array.from({ length: rows }, (_, i) => ({ id: `pay_${i + 1}`, status: i % 3 === 0 ? "FAILED" : "SUCCEEDED", attemptedAt: daysAgo(1 + (i % 120)), amount: 400 + (i % 5) * 100 }));
  const overdue = invoices.reduce((a, i) => a + i.amount, 0);
  return {
    case: { id: "case_1", number: "CASE-1", customerId: "cus_1", organizationId: "org_1", status: "OPEN", type: "OVERDUE_INVOICE" },
    customer: { id: "cus_1", organizationId: "org_1", name: "Latency Customer", segment: "SMB", status: "ACTIVE" },
    metrics: { overdueAmount: overdue, totalOutstanding: overdue, maxOverdueDays: 94, failedPayments30d: payments.filter((p) => p.status === "FAILED" && true).length, overdueInvoiceCount: rows, currency: "EUR" },
    invoices,
    payments,
    cases: [],
  };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

const llm = new OllamaProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, numCtx: config.llm.numCtx, maxOutputTokens: config.llm.maxOutputTokens, apiKey: config.llm.apiKey });
const health = await llm.health(3000).catch(() => ({ ok: false, modelAvailable: false }));
if (!health.ok || health.modelAvailable === false) {
  console.error(`Ollama is not reachable at ${config.llm.baseUrl} or model "${config.llm.model}" is not installed.\nRun: ollama pull ${config.llm.model}`);
  process.exit(2);
}

const results: Array<Record<string, unknown>> = [];
let worstP95 = 0;
for (const rows of SIZES) {
  const latencies: number[] = [];
  let completed = 0, degraded = 0, evidenceCount = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = await new AgentRunner({
      client: new InMemoryCore(syntheticWorld(rows)),
      llm,
      logger: createLogger({ level: "silent" }),
      config: { toolTimeoutMs: 5000, llmTimeoutMs: GENEROUS_MS, totalTimeoutMs: GENEROUS_MS * 3, maxRetries: 0, maxRepairs: 0 },
      clock: () => EVAL_NOW,
    }).run({ organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "SYSTEM" } });
    if (!r.ok) continue;
    latencies.push(r.response.model.latencyMs);
    evidenceCount = Math.max(evidenceCount, r.response.evidence.length);
    if (r.response.status === "COMPLETED") completed += 1;
    else degraded += 1;
  }
  const p50 = pct(latencies, 50), p95 = pct(latencies, 95);
  worstP95 = Math.max(worstP95, p95);
  results.push({ rowsPerList: rows, runs: RUNS, completedByModel: completed, degraded, p50Ms: p50, p95Ms: p95, maxMs: Math.max(0, ...latencies) });
}

// 25% headroom over the worst p95, rounded up to whole seconds.
const recommendedRequestMs = Math.max(2000, Math.ceil((worstP95 * 1.25) / 1000) * 1000);
// up to 3 model calls (1 + retry + repair) + ~5 s of tool calls.
const recommendedTotalMs = recommendedRequestMs * 3 + 5000;
console.table(results);
const summary = { model: config.llm.model, currentRequestTimeoutMs: config.llm.timeoutMs, recommendedRequestMs, recommendedTotalMs, note: "Latency is machine-specific: run this on the machine that will serve production traffic." };
console.log(JSON.stringify(summary, null, 2));
console.log(`\nSuggested env:\n  AI_REQUEST_TIMEOUT_MS=${recommendedRequestMs}\n  AI_TOTAL_TIMEOUT_MS=${recommendedTotalMs}`);
if (config.llm.timeoutMs < worstP95) console.log(`WARNING: current AI_REQUEST_TIMEOUT_MS (${config.llm.timeoutMs}) is below the measured p95 (${worstP95} ms): most analyses will end DEGRADED.`);
const dir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}latency.json`, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
