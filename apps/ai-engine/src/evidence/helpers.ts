/** Tolerant, side-effect free helpers for reading Core API payloads. */
export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const WRAP_KEYS = ["data", "item", "result", "payload"];

/** Unwraps `{data: {...}}`-style envelopes (max 3 levels). Returns undefined when no object is found. */
export function unwrapObject(raw: unknown, namedKeys: string[] = []): Rec | undefined {
  let cur: unknown = raw;
  for (let i = 0; i < 3 && isRec(cur); i++) {
    const obj: Rec = cur;
    const next = [...namedKeys, ...WRAP_KEYS].map((k) => obj[k]).find(isRec);
    if (!next) return obj;
    cur = next;
  }
  return isRec(cur) ? cur : undefined;
}

/** Accepts `[...]` or `{data|items|results|<named>: [...]}` (max 2 levels). */
export function unwrapArray(raw: unknown, namedKeys: string[] = [], depth = 0): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!isRec(raw) || depth > 2) return undefined;
  for (const k of [...namedKeys, "data", "items", "results", "records"]) {
    const v = raw[k];
    if (Array.isArray(v)) return v;
    if (isRec(v)) {
      const inner = unwrapArray(v, namedKeys, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

export function pickStr(o: Rec, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

export function pickNum(o: Rec, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export function pickBool(o: Rec, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

export function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function pickDate(o: Rec, ...keys: string[]): Date | undefined {
  for (const k of keys) {
    const d = toDate(o[k]);
    if (d) return d;
  }
  return undefined;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Major-unit amount from `major` keys, or minor-unit (cents) amount from `minor` keys / 100. */
export function pickMoney(o: Rec, major: string[], minor: string[]): number | undefined {
  const m = pickNum(o, ...major);
  if (m !== undefined) return round2(m);
  const c = pickNum(o, ...minor);
  if (c !== undefined) return round2(c / 100);
  return undefined;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

const startOfUtcDay = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whole UTC calendar days from `earlier` to `later` (negative when later < earlier). */
export function daysBetween(later: Date, earlier: Date): number {
  return Math.floor((startOfUtcDay(later) - startOfUtcDay(earlier)) / 86_400_000);
}

export const upper = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.toUpperCase());
