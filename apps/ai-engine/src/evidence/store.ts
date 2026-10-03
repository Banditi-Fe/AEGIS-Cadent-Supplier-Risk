import type { EvidenceRecord, EvidenceSourceType } from "@aegis/contracts-ai";
import { sanitizeRef, sanitizeUntrusted } from "./sanitize.js";

export type EvidenceValue = string | number | boolean | null;

/** Builds canonical evidence records for ONE tool result. */
export class EvidenceBuilder {
  readonly records: EvidenceRecord[] = [];
  readonly untrusted = new Set<string>();
  flaggedTextCount = 0;
  private readonly ids = new Set<string>();

  constructor(private readonly observedAt: string) {}

  /** Adds a factual field. `undefined` is skipped (never fabricate), `null` is a real "no value". */
  add(
    sourceType: EvidenceSourceType,
    ref: string,
    sourceId: string,
    field: string,
    value: EvidenceValue | undefined,
  ): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" && !Number.isFinite(value)) return undefined;
    const evidenceId = `${sourceType}:${sanitizeRef(ref)}:${field}`;
    if (this.ids.has(evidenceId)) return evidenceId;
    this.ids.add(evidenceId);
    this.records.push({
      evidenceId,
      sourceType,
      sourceId: String(sourceId).slice(0, 200) || "unknown",
      field,
      value: typeof value === "string" ? value.slice(0, 300) : value,
      observedAt: this.observedAt,
    });
    return evidenceId;
  }

  /** Adds a free-text field (untrusted): sanitised, truncated and flagged for the prompt. */
  addText(
    sourceType: EvidenceSourceType,
    ref: string,
    sourceId: string,
    field: string,
    raw: unknown,
    maxLen = 200,
  ): string | undefined {
    const { text, flagged } = sanitizeUntrusted(raw, maxLen);
    if (text === "") return undefined;
    if (flagged) this.flaggedTextCount += 1;
    const id = this.add(sourceType, ref, sourceId, field, text);
    if (id) this.untrusted.add(id);
    return id;
  }
}

/** All evidence collected during ONE agent run. The single source of truth for validation. */
export class EvidenceStore {
  private readonly map = new Map<string, EvidenceRecord>();
  private readonly untrusted = new Set<string>();

  addAll(records: EvidenceRecord[], untrustedIds: Iterable<string> = []): void {
    for (const r of records) if (!this.map.has(r.evidenceId)) this.map.set(r.evidenceId, r);
    for (const id of untrustedIds) this.untrusted.add(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }
  get(id: string): EvidenceRecord | undefined {
    return this.map.get(id);
  }
  all(): EvidenceRecord[] {
    return [...this.map.values()];
  }
  get size(): number {
    return this.map.size;
  }
  isUntrusted(id: string): boolean {
    return this.untrusted.has(id);
  }
  byIds(ids: Iterable<string>): EvidenceRecord[] {
    const out: EvidenceRecord[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const r = this.map.get(id);
      if (r && !seen.has(id)) {
        seen.add(id);
        out.push(r);
      }
    }
    return out;
  }

  numericValues(): number[] {
    return this.all()
      .map((r) => r.value)
      .filter((v): v is number => typeof v === "number");
  }

  /** Strings that an identifier mentioned in free text may legitimately be found in. */
  haystack(): string[] {
    const out: string[] = [];
    for (const r of this.map.values()) {
      out.push(r.evidenceId, r.sourceId);
      if (typeof r.value === "string") out.push(r.value);
    }
    return out;
  }

  dateValues(): string[] {
    return this.all()
      .map((r) => r.value)
      .filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))
      .map((v) => v.slice(0, 10));
  }
}
