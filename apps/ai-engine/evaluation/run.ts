import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../src/agent/index.js";
import { loadConfig } from "../src/config/index.js";
import { LLMError, OllamaProvider, type LLMProvider } from "../src/llm/index.js";
import { createLogger } from "../src/logging/index.js";
import { SCENARIOS } from "./scenarios.js";
import { EVAL_NOW, InMemoryCore } from "./world.js";

/** Stands in for the model when Ollama is not available: forces the deterministic fallback path. */
class OfflineLLM implements LLMProvider {
  readonly provider = "ollama";
  constructor(readonly model: string) {}
  async generateStructured(): Promise<never> {
    throw new LLMError("UNAVAILABLE", "offline evaluation mode");
  }
  async health() {
    return { ok: false, latencyMs: 0, detail: "offline" };
  }
}

const config = loadConfig();
const forceOffline = process.argv.includes("--offline");
let llm: LLMProvider = new OllamaProvider({ baseUrl: config.llm.baseUrl, model: config.llm.model, numCtx: config.llm.numCtx, maxOutputTokens: config.llm.maxOutputTokens, apiKey: config.llm.apiKey });
let mode: "ollama" | "fallback-only" = "ollama";
if (forceOffline) mode = "fallback-only";
else {
  const h = await llm.health(3000).catch(() => ({ ok: false, modelAvailable: false }));
  if (!h.ok || h.modelAvailable === false) mode = "fallback-only";
}
if (mode === "fallback-only") llm = new OfflineLLM(config.llm.model);

let correct = 0, signalOk = 0, invalid = 0, fallback = 0, evidenceFail = 0, completed = 0, errors = 0;
const rows: Array<Record<string, unknown>> = [];
for (const sc of SCENARIOS) {
  const r = await new AgentRunner({
    client: new InMemoryCore(sc.world),
    llm,
    logger: createLogger({ level: "silent" }),
    config: { toolTimeoutMs: 1000, llmTimeoutMs: config.llm.timeoutMs },
    clock: () => EVAL_NOW,
  }).run({ organizationId: "org_1", caseId: "case_1", customerId: "cus_1", requestedBy: { type: "SYSTEM" } });
  if (!r.ok) {
    errors += 1;
    rows.push({ id: sc.id, title: sc.title, error: r.error.error.code });
    continue;
  }
  const got = r.response;
  const gotSignals: string[] = [...new Set(got.signals.map((s) => s.code as string))].sort();
  // Deterministic signals are validated separately from model output: they are computed by code.
  const expectedSignals: string[] = [...sc.expectedSignals].sort();
  const signalMatch = got.status === "DEGRADED" ? JSON.stringify(gotSignals) === JSON.stringify(expectedSignals) : expectedSignals.every((c) => gotSignals.includes(c)) && gotSignals.every((c) => expectedSignals.includes(c));
  const actionMatch = got.recommendedAction.type === sc.expectedAction;
  if (signalMatch) signalOk += 1;
  if (actionMatch) correct += 1;
  invalid += r.diagnostics.invalidOutputs;
  evidenceFail += r.diagnostics.evidenceValidationFailures;
  if (r.diagnostics.fallbackUsed) fallback += 1;
  if (got.status === "COMPLETED") completed += 1;
  rows.push({ id: sc.id, title: sc.title, status: got.status, expected: sc.expectedAction, got: got.recommendedAction.type, actionMatch, signalMatch, confidence: got.confidence });
}

const total = SCENARIOS.length;
const summary = {
  mode,
  model: config.llm.model,
  total,
  correctRecommendations: correct,
  score: `${correct}/${total}`,
  accuracy: Math.round((correct / total) * 1000) / 1000,
  signalAccuracy: `${signalOk}/${total}`,
  invalidOutputCount: invalid,
  fallbackCount: fallback,
  evidenceValidationFailures: evidenceFail,
  completedByModel: completed,
  runErrors: errors,
};
console.table(rows);
console.log(JSON.stringify(summary, null, 2));
if (mode === "fallback-only") {
  console.log("NOTE: Ollama was not reachable, so only the deterministic DEGRADED fallback was evaluated (it can only answer REQUEST_HUMAN_REVIEW / SEND_PAYMENT_REMINDER / NO_ACTION by design). Start Ollama to evaluate the model.");
}
const dir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}latest.json`, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));
process.exit(signalOk === total && errors === 0 ? 0 : 1);
