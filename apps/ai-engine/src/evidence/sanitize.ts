/**
 * Business data is DATA, never instructions. Free-text fields (names, notes, descriptions,
 * failure reasons, ...) are normalised here before they can become evidence / reach the prompt.
 */
export const INSTRUCTION_WITHHELD = "[withheld: instruction-like text]";

// Zero-width, bidi-control and other invisible characters used to hide payloads.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g;
// ASCII + C1 control characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\b.{0,30}\b(previous|prior|above|earlier|all|any|the)\b.{0,30}\b(instruction|prompt|rule|message)s?\b/i,
  /\bdisregard\b.{0,30}\b(previous|prior|above|earlier|instruction|rule|polic)/i,
  /\b(system|developer|assistant)\s*(prompt|message|instruction|role)s?\b/i,
  /\b(new|updated|override|real)\s+instructions?\b/i,
  /\byou\s+(are|must|should|will|shall)\s+(now\s+)?(act|behave|respond|ignore|output|return|recommend|approve|execute|answer|set|mark)\b/i,
  /\b(approve|authori[sz]e|execute|release|unblock|bypass|override|skip)\b.{0,40}\b(payment|action|hold|polic|approval|refund|transfer|check|review)/i,
  /\b(set|mark|change|switch)\b.{0,30}\b(decision|status|risk|polic|threshold|mode)\b/i,
  /\bdo\s+not\s+(flag|report|mention|escalate|review|log)\b/i,
  /<\s*\/?\s*(system|assistant|user|instructions?|prompt)\s*>/i,
  /\[\s*\/?\s*inst\s*\]|<\|[^|]{0,30}\|>/i,
  /\b(decision|verdict|mode)\s*[:=]\s*["']?(AUTO|APPROVAL|BLOCKED)\b/i,
  /\brespond\s+(only\s+)?with\b/i,
  /\bjailbreak\b|\bDAN mode\b/i,
];

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

export interface SanitizedText {
  text: string;
  flagged: boolean;
}

/** Strips control / invisible characters, collapses whitespace, truncates, withholds instruction-like text. */
export function sanitizeUntrusted(input: unknown, maxLen = 200): SanitizedText {
  const raw = typeof input === "string" ? input : typeof input === "number" || typeof input === "boolean" ? String(input) : "";
  const cleaned = raw.replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return { text: "", flagged: false };
  if (looksLikeInstruction(cleaned)) return { text: INSTRUCTION_WITHHELD, flagged: true };
  const text = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
  return { text, flagged: false };
}

/** Makes an identifier safe for use inside an evidenceId (colon is the separator). */
export function sanitizeRef(ref: string): string {
  const cleaned = String(ref).replace(INVISIBLE, "").replace(/[^A-Za-z0-9._@#-]/g, "_");
  return (cleaned === "" ? "unknown" : cleaned).slice(0, 64);
}
