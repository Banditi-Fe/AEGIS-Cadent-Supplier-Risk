/**
 * Conformance probe against a REAL Core API (Backend A). Read-only: only GETs under /internal/v1/*.
 *     CORE_API_BASE_URL=http://core:4000 CORE_API_SERVICE_KEY=... \
 *       pnpm check:core-api -- <organizationId> <caseId> <customerId>
 * For every tool it reports: HTTP result, recognised shape, record count, evidence produced and every
 * deviation from docs/core-api-contract.md. Exit code 1 when any tool fails or deviates.
 * Output contains only field names / counts (never values) so it is safe to paste in a ticket.
 */
import { TOOL_NAMES } from "@aegis/contracts-ai";
import { loadConfig } from "../src/config/index.js";
import { HttpCoreApiClient, CoreApiError, TOOLS, inspectPayload } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/types.js";

const [organizationId, caseId, customerId] = process.argv.slice(2).filter((a) => a !== "--");
if (!organizationId || !caseId || !customerId) {
  console.error("Usage: pnpm check:core-api -- <organizationId> <caseId> <customerId>");
  process.exit(2);
}
const config = loadConfig();
if (!config.coreApi.baseUrl || !config.coreApi.serviceKey) {
  console.error("Set CORE_API_BASE_URL and CORE_API_SERVICE_KEY (or AI_ENGINE_SHARED_SECRET).");
  process.exit(2);
}
const client = new HttpCoreApiClient({ baseUrl: config.coreApi.baseUrl, serviceKey: config.coreApi.serviceKey });
const ctx: ToolContext = { organizationId, caseId, customerId, now: new Date() };

let problems = 0;
const rows: Array<Record<string, unknown>> = [];
for (const name of TOOL_NAMES) {
  const tool = TOOLS[name];
  const t0 = performance.now();
  try {
    const raw = await client.get(tool.path(ctx), { timeoutMs: config.coreApi.toolTimeoutMs, organizationId });
    const shape = inspectPayload(name, raw);
    if (shape.fatal) {
      problems += 1;
      rows.push({ tool: name, path: tool.path(ctx), result: "UNRECOGNISED SHAPE", detail: shape.fatal, ms: Math.round(performance.now() - t0) });
      continue;
    }
    const parsed = tool.parse(raw, { ...ctx, observedAt: ctx.now.toISOString() });
    const notes = [...shape.notes, ...(parsed.notes ?? [])];
    if (notes.length) problems += 1;
    rows.push({ tool: name, path: tool.path(ctx), result: notes.length ? "DEVIATIONS" : "OK", records: parsed.recordCount, evidence: parsed.evidence.length, flaggedText: parsed.flaggedTextCount, detail: notes.join(" | ") || "-", ms: Math.round(performance.now() - t0) });
  } catch (err) {
    problems += 1;
    const code = err instanceof CoreApiError ? `${err.code}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}` : "ERROR";
    rows.push({ tool: name, path: tool.path(ctx), result: "FAILED", detail: code, ms: Math.round(performance.now() - t0) });
  }
}
console.table(rows);
console.log(problems === 0 ? "Core API matches the contract for this case." : `${problems} tool(s) failed or deviate. Send this table to the AI Engine owner; then trim the parser aliases (see docs/core-api-contract.md).`);
process.exit(problems === 0 ? 0 : 1);
