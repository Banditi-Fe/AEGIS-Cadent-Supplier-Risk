import { TOOL_NAMES } from "@aegis/contracts-ai";
import { EvidenceStore, detectSignals, emptyFacts, type CollectedFacts } from "../../src/evidence/index.js";
import { TOOLS, ToolBudget, executeTool, type ToolExecution } from "../../src/tools/index.js";
import { FakeCore, NOW, type World } from "./fakes.js";

export const CTX = { organizationId: "org_1", caseId: "case_1", customerId: "cus_1", now: NOW };

/** Runs the real tools against a fake Core API and builds facts / evidence / signals exactly like the runner does. */
export async function collect(world: World) {
  const core = new FakeCore(world);
  const deps = { client: core, budget: new ToolBudget(), timeoutMs: 1000, clock: () => NOW };
  const executions: ToolExecution[] = [];
  for (const t of TOOL_NAMES) executions.push(await executeTool(TOOLS[t], CTX, deps));
  const facts: CollectedFacts = emptyFacts();
  const store = new EvidenceStore();
  for (const e of executions) {
    Object.assign(facts, e.facts);
    facts.toolStatus[e.tool] = e.status === "SUCCESS" ? "SUCCESS" : "FAILED";
    facts.notes.push(...e.notes);
    store.addAll(e.evidence, e.untrustedIds);
  }
  return { core, executions, facts, store, signals: detectSignals(facts) };
}
