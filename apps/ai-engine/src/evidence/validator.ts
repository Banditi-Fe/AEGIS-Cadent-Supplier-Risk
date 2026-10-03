import {
  ACTION_TYPES,
  EVIDENCE_SOURCE_TYPES,
  LlmAnalysisOutputSchema,
  SIGNAL_CODES,
  type LlmAnalysisOutput,
  type SignalCode,
} from "@aegis/contracts-ai";
import type { CollectedFacts } from "./facts.js";
import { round2 } from "./helpers.js";
import { SEVERITY_RANK, resolveFacts, type DeterministicSignal } from "./signals.js";
import type { EvidenceStore } from "./store.js";

export type IssueCode =
  | "MALFORMED_JSON"
  | "SCHEMA"
  | "UNKNOWN_EVIDENCE_ID"
  | "INVENTED_SIGNAL"
  | "UNSUPPORTED_NUMBER"
  | "UNSUPPORTED_DATE"
  | "UNSUPPORTED_IDENTIFIER"
  | "UNSUPPORTED_ACTION"
  | "UNSUPPORTED_SEGMENT"
  | "INCONSISTENT_BEHAVIOR"
  | "AUTHORITY_DECISION";

export interface ValidationIssue {
  code: IssueCode;
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; output: LlmAnalysisOutput } | { ok: false; issues: ValidationIssue[] };

/** Issue codes that mean "the model referenced facts/evidence that do not exist" (hallucination). */
export const EVIDENCE_ISSUE_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "UNKNOWN_EVIDENCE_ID",
  "INVENTED_SIGNAL",
  "UNSUPPORTED_NUMBER",
  "UNSUPPORTED_DATE",
  "UNSUPPORTED_IDENTIFIER",
  "UNSUPPORTED_SEGMENT",
]);

/** Accepts raw JSON or JSON inside exactly one ```json fence. Anything else is malformed. */
export function parseLlmJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let t = text.replace(/^\uFEFF/, "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = (fence[1] ?? "").trim();
  if (!t.startsWith("{")) return { ok: false, error: "output is not a JSON object" };
  try {
    return { ok: true, value: JSON.parse(t) as unknown };
  } catch {
    return { ok: false, error: "output is not valid JSON" };
  }
}

/* ---------------------------------------------------------------- authority */
const AUTHORITY_KEYS = new Set(["decision", "aegisdecision", "finaldecision", "authority", "verdict", "auto", "approval", "blocked", "mode"]);
const AUTHORITY_VALUE = /^\s*(AUTO|APPROVAL|BLOCKED)\s*$/i;
const AUTHORITY_ASSIGN = /\b(decision|verdict|outcome|mode|status|authority)\s*[:=]\s*["']?(AUTO|APPROVAL|BLOCKED)\b/i;

/** The AI may never emit AUTO / APPROVAL / BLOCKED as an authority field or value. */
export function findAuthorityViolations(value: unknown, path = "$", depth = 0): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (depth > 6) return out;
  if (typeof value === "string") {
    if (AUTHORITY_VALUE.test(value) || AUTHORITY_ASSIGN.test(value)) {
      out.push({ code: "AUTHORITY_DECISION", path, message: "AI output must not contain an AUTO/APPROVAL/BLOCKED decision; Core API decides that" });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...findAuthorityViolations(v, `${path}[${i}]`, depth + 1)));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (AUTHORITY_KEYS.has(k.toLowerCase())) {
        out.push({ code: "AUTHORITY_DECISION", path: `${path}.${k}`, message: "AI output must not contain a decision/authority field; Core API decides AUTO/APPROVAL/BLOCKED" });
      }
      out.push(...findAuthorityViolations(v, `${path}.${k}`, depth + 1));
    }
  }
  return out;
}

/* -------------------------------------------------------------- text claims */
const SOURCE_PREFIX = EVIDENCE_SOURCE_TYPES.join("|");
const EVIDENCE_TOKEN = new RegExp(`\\b(?:${SOURCE_PREFIX}):[^\\s,;)"'\\]]+`, "g");
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
const IDENT = /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g;
const NUMBER = /(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*%)?/g;
const CODE_LIKE = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
/** Constants that legitimately appear in explanations (thresholds / look-back windows). */
const CONSTANT_NUMBERS = [30, 60, 90, 180, 5000, 25000, 50, 0.5];
const KNOWN_ENUMS = new Set<string>([...SIGNAL_CODES, ...ACTION_TYPES]);
const STRONG_SIGNALS: SignalCode[] = [
  "OVERDUE_30_DAYS",
  "OVERDUE_60_DAYS",
  "HIGH_OUTSTANDING_BALANCE",
  "REPEATED_PAYMENT_FAILURE",
  "HIGH_LATE_PAYMENT_RATIO",
  "REPEATED_PARTIAL_PAYMENT",
];
const UNKNOWN_SEGMENT_WORDS = new Set(["unknown", "unspecified", "n/a", "not available"]);

export class EvidenceValidator {
  private readonly allowedNumbers: number[];
  private readonly haystack: string[];
  private readonly dates: Set<string>;
  private readonly codes: Set<SignalCode>;

  constructor(
    private readonly store: EvidenceStore,
    private readonly signals: DeterministicSignal[],
    private readonly facts: CollectedFacts,
  ) {
    const allowed = new Set<number>(CONSTANT_NUMBERS);
    for (const v of store.numericValues()) {
      allowed.add(v);
      allowed.add(Math.round(v));
      if (v >= 0 && v <= 1) {
        allowed.add(round2(v * 100));
        allowed.add(Math.round(v * 100));
      }
    }
    this.allowedNumbers = [...allowed];
    this.haystack = store.haystack().map((s) => s.toLowerCase());
    this.dates = new Set(store.dateValues());
    this.codes = new Set(signals.map((s) => s.code));
  }

  validate(raw: unknown): ValidationResult {
    const issues: ValidationIssue[] = [...findAuthorityViolations(raw)];

    const parsed = LlmAnalysisOutputSchema.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues.slice(0, 12)) {
        issues.push({ code: "SCHEMA", path: i.path.join(".") || "(root)", message: i.message.slice(0, 200) });
      }
      return { ok: false, issues };
    }
    const out = parsed.data;
    this.checkEvidenceIds(out, issues);
    this.checkSignals(out, issues);
    this.checkAction(out, issues);
    this.checkSegment(out, issues);
    this.checkBehavior(out, issues);
    this.checkTexts(out, issues);
    return issues.length ? { ok: false, issues } : { ok: true, output: out };
  }

  /* ----------------------------------------------------------- evidence ids */
  private checkEvidenceIds(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    out.signals.forEach((s, i) =>
      s.evidenceIds.forEach((id, j) => {
        if (!this.store.has(id)) {
          issues.push({ code: "UNKNOWN_EVIDENCE_ID", path: `signals[${i}].evidenceIds[${j}]`, message: `evidenceId "${id.slice(0, 120)}" does not exist in the supplied evidence` });
        }
      }),
    );
    out.recommendedAction.evidenceIds.forEach((id, j) => {
      if (!this.store.has(id)) {
        issues.push({ code: "UNKNOWN_EVIDENCE_ID", path: `recommendedAction.evidenceIds[${j}]`, message: `evidenceId "${id.slice(0, 120)}" does not exist in the supplied evidence` });
      }
    });
  }

  private checkSignals(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    out.signals.forEach((s, i) => {
      if (!this.codes.has(s.code as SignalCode)) {
        issues.push({ code: "INVENTED_SIGNAL", path: `signals[${i}].code`, message: `signal "${s.code.slice(0, 64)}" is not among the deterministic signals; do not invent signals` });
      }
    });
  }

  /* ----------------------------------------------------------------- action */
  private checkAction(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    const type = out.recommendedAction.type;
    const has = (c: SignalCode): boolean => this.codes.has(c);
    const path = "recommendedAction.type";
    const r = resolveFacts(this.facts);
    const bad = (message: string): void => {
      issues.push({ code: "UNSUPPORTED_ACTION", path, message });
    };

    if ((has("DISPUTED_PAYMENT") || has("DATA_CONFLICT")) && type !== "REQUEST_HUMAN_REVIEW") {
      bad("a disputed payment or conflicting data requires REQUEST_HUMAN_REVIEW");
      return;
    }
    switch (type) {
      case "SEND_PAYMENT_REMINDER":
        if (!r.overdueExists) bad("SEND_PAYMENT_REMINDER requires overdue exposure in the evidence");
        break;
      case "CREATE_COLLECTION_CASE":
        if (!r.overdueExists || !STRONG_SIGNALS.some(has)) bad("CREATE_COLLECTION_CASE requires overdue exposure plus at least one strong deterministic signal");
        break;
      case "PLACE_ACCOUNT_HOLD": {
        const severe = has("OVERDUE_60_DAYS") || (has("OVERDUE_30_DAYS") && (has("REPEATED_PAYMENT_FAILURE") || has("HIGH_OUTSTANDING_BALANCE")));
        if (!severe) bad("PLACE_ACCOUNT_HOLD is only supported in severe situations (60+ days overdue, or 30+ days overdue with repeated failures / high balance)");
        else if (has("ACCOUNT_ON_HOLD")) bad("the account is already on hold");
        break;
      }
      case "NO_ACTION":
        if (this.signals.some((s) => s.code !== "ACCOUNT_ON_HOLD")) bad("NO_ACTION is unsupported while deterministic risk signals exist");
        break;
      case "REQUEST_HUMAN_REVIEW":
        break;
    }
  }

  /* -------------------------------------------------- customer facts / tone */
  private checkSegment(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    const seg = out.customerSituation.segment.trim().toLowerCase();
    const evidence = this.store.all().find((r) => r.sourceType === "customer" && r.field === "segment");
    if (evidence) {
      if (String(evidence.value).trim().toLowerCase() !== seg) {
        issues.push({ code: "UNSUPPORTED_SEGMENT", path: "customerSituation.segment", message: `segment must equal the evidence value "${String(evidence.value).slice(0, 60)}"` });
      }
    } else if (!UNKNOWN_SEGMENT_WORDS.has(seg)) {
      issues.push({ code: "UNSUPPORTED_SEGMENT", path: "customerSituation.segment", message: 'no segment evidence exists; use "UNKNOWN"' });
    }
  }

  private checkBehavior(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    const b = out.customerSituation.paymentBehavior;
    const r = resolveFacts(this.facts);
    if (b === "STABLE" && this.signals.some((s) => SEVERITY_RANK[s.severity] >= SEVERITY_RANK.MEDIUM && s.code !== "ACCOUNT_ON_HOLD")) {
      issues.push({ code: "INCONSISTENT_BEHAVIOR", path: "customerSituation.paymentBehavior", message: "STABLE contradicts the deterministic risk signals" });
    }
    if (b === "FAILING" && (r.failed30d?.value ?? 0) < 1) {
      issues.push({ code: "INCONSISTENT_BEHAVIOR", path: "customerSituation.paymentBehavior", message: "FAILING requires failed payments in the evidence" });
    }
  }

  /* -------------------------------------------------------- text-level claims */
  private checkTexts(out: LlmAnalysisOutput, issues: ValidationIssue[]): void {
    const texts: Array<{ path: string; text: string; numeric: boolean }> = [
      { path: "summary", text: out.summary, numeric: true },
      { path: "recommendedAction.reason", text: out.recommendedAction.reason, numeric: true },
      { path: "nextBestStep", text: out.nextBestStep, numeric: false },
      ...out.signals.map((s, i) => ({ path: `signals[${i}].explanation`, text: s.explanation, numeric: true })),
      ...out.uncertainties.map((u, i) => ({ path: `uncertainties[${i}]`, text: u, numeric: true })),
    ];
    for (const t of texts) this.checkText(t.path, t.text, t.numeric, issues);
  }

  private checkText(path: string, text: string, numeric: boolean, issues: ValidationIssue[]): void {
    let rest = text;

    for (const token of rest.match(EVIDENCE_TOKEN) ?? []) {
      const clean = token.replace(/[.:]+$/, "");
      if (!this.store.has(clean)) {
        issues.push({ code: "UNKNOWN_EVIDENCE_ID", path, message: `text cites evidence id "${clean.slice(0, 120)}" which does not exist` });
      }
    }
    rest = rest.replace(EVIDENCE_TOKEN, " ");

    for (const d of rest.match(ISO_DATE) ?? []) {
      if (!this.dates.has(d.slice(0, 10))) {
        issues.push({ code: "UNSUPPORTED_DATE", path, message: `date ${d.slice(0, 10)} does not appear in the evidence` });
      }
    }
    rest = rest.replace(ISO_DATE, " ");

    for (const id of rest.match(IDENT) ?? []) {
      if (!/\d/.test(id) || KNOWN_ENUMS.has(id) || CODE_LIKE.test(id)) continue;
      if (!this.haystack.some((h) => h.includes(id.toLowerCase()))) {
        issues.push({ code: "UNSUPPORTED_IDENTIFIER", path, message: `identifier "${id.slice(0, 64)}" does not appear in the evidence` });
      }
    }
    rest = rest.replace(IDENT, " ");

    if (!numeric) return;
    for (const m of rest.matchAll(NUMBER)) {
      const n = Number((m[1] ?? "").replace(/,/g, ""));
      if (!Number.isFinite(n) || this.isAllowed(n)) continue;
      issues.push({ code: "UNSUPPORTED_NUMBER", path, message: `number ${m[1]}${m[2] ? "%" : ""} does not correspond to any collected data` });
    }
  }

  private isAllowed(n: number): boolean {
    return this.allowedNumbers.some((a) => Math.abs(a - n) <= 0.0051 || (Number.isInteger(n) && Math.abs(a - n) < 0.5));
  }
}
