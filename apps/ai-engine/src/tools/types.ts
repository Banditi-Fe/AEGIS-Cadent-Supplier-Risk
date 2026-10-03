import type { EvidenceRecord, ToolName } from "@aegis/contracts-ai";
import type { CollectedFacts } from "../evidence/facts.js";

export interface ToolContext {
  organizationId: string;
  caseId: string;
  customerId: string;
  /** Reference time of the whole run (used for overdue / window calculations). */
  now: Date;
}

export interface ParseContext extends ToolContext {
  /** When the data was retrieved (ISO). */
  observedAt: string;
}

export type ParsedFacts = Partial<Omit<CollectedFacts, "toolStatus" | "notes">>;

export interface ToolParseResult {
  evidence: EvidenceRecord[];
  untrustedIds: string[];
  flaggedTextCount: number;
  recordCount: number;
  facts: ParsedFacts;
  notes?: string[];
}

export class ToolDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolDataError";
  }
}

/** A read-only tool: builds a Core API GET path and normalises the response into evidence + facts. */
export interface ReadOnlyTool {
  readonly name: ToolName;
  readonly description: string;
  path(ctx: ToolContext): string;
  parse(raw: unknown, ctx: ParseContext): ToolParseResult;
}
