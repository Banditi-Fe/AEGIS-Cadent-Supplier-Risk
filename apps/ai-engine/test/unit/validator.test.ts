import { describe, expect, it } from "vitest";
import { EvidenceValidator, findAuthorityViolations, parseLlmJson } from "../../src/evidence/index.js";
import { collect } from "../helpers/context.js";
import { baseWorld, daysAgo } from "../helpers/fakes.js";

async function setup(world = baseWorld()) {
  const c = await collect(world);
  const validator = new EvidenceValidator(c.store, c.signals, c.facts);
  const signals = c.signals.map((s) => ({ code: s.code, severity: s.severity, evidenceIds: s.evidenceIds, explanation: s.explanation }));
  const anyId = signals[0]!.evidenceIds[0]!;
  const good = (over: Record<string, unknown> = {}) => ({
    summary: "Overdue exposure detected from the supplied evidence.",
    customerSituation: { segment: "SMB", paymentBehavior: "DELAYED" },
    signals,
    recommendedAction: { type: "REQUEST_HUMAN_REVIEW", priority: "MEDIUM", reason: "Overdue exposure with a failed payment.", evidenceIds: [anyId] },
    confidence: 0.8,
    uncertainties: [],
    nextBestStep: "Route to a reviewer.",
    ...over,
  });
  const codes = (raw: unknown): string[] => {
    const r = validator.validate(raw);
    return r.ok ? [] : [...new Set(r.issues.map((i) => i.code))];
  };
  return { c, validator, good, codes, anyId };
}

describe("EvidenceValidator (direct)", () => {
  it("accepts a grounded output", async () => {
    const { good, codes } = await setup();
    expect(codes(good())).toEqual([]);
  });

  it("numbers: accepts numbers present in evidence (incl. thousands separators / rounding), rejects invented ones", async () => {
    const { good, codes } = await setup();
    expect(codes(good({ summary: "The customer owes 1,200 EUR and is 45 days overdue." }))).toEqual([]);
    expect(codes(good({ summary: "The customer owes 9,999 EUR." }))).toContain("UNSUPPORTED_NUMBER");
    expect(codes(good({ nextBestStep: "Call about 777 euros." }))).toEqual([]); // nextBestStep is not numeric-checked
    expect(codes(good({ recommendedAction: { type: "REQUEST_HUMAN_REVIEW", priority: "LOW", reason: "Debt of 31337.", evidenceIds: [] } }))).toContain("SCHEMA"); // min 1 evidence id
  });

  it("numbers: an invented percentage is rejected", async () => {
    const { good, codes } = await setup();
    expect(codes(good({ summary: "Late payment ratio is 93%." }))).toContain("UNSUPPORTED_NUMBER");
  });

  it("dates: a date that is not in the evidence is rejected, an evidence date is accepted", async () => {
    const { good, codes } = await setup();
    const due = daysAgo(45).slice(0, 10);
    expect(codes(good({ summary: `Invoice was due ${due}.` }))).toEqual([]);
    expect(codes(good({ summary: "Invoice was due 2020-01-15." }))).toContain("UNSUPPORTED_DATE");
  });

  it("identifiers: invented invoice / payment ids are rejected, real ones accepted", async () => {
    const { good, codes } = await setup();
    expect(codes(good({ summary: "Invoice INV-1 is overdue." }))).toEqual([]);
    expect(codes(good({ summary: "Invoice INV-9999 is overdue." }))).toContain("UNSUPPORTED_IDENTIFIER");
  });

  it("evidence ids: unknown id in signals, in action and cited in text", async () => {
    const { good, codes, c } = await setup();
    const bad = c.signals.map((s) => ({ ...s, evidenceIds: ["invoice:FAKE:dueAt"] }));
    expect(codes(good({ signals: bad }))).toContain("UNKNOWN_EVIDENCE_ID");
    expect(codes(good({ recommendedAction: { type: "REQUEST_HUMAN_REVIEW", priority: "LOW", reason: "x", evidenceIds: ["metrics:cus_1:nope"] } }))).toContain("UNKNOWN_EVIDENCE_ID");
    expect(codes(good({ summary: "See invoice:INV-404:dueAt for details." }))).toContain("UNKNOWN_EVIDENCE_ID");
  });

  it("signals: a signal that was not detected deterministically is rejected", async () => {
    const { good, codes, anyId } = await setup();
    const invented = { code: "DISPUTED_PAYMENT", severity: "HIGH", evidenceIds: [anyId], explanation: "Disputed." };
    expect(codes(good({ signals: [invented] }))).toContain("INVENTED_SIGNAL");
  });

  it("segment: must equal the evidence value (case-insensitive)", async () => {
    const { good, codes } = await setup();
    expect(codes(good({ customerSituation: { segment: "smb", paymentBehavior: "DELAYED" } }))).toEqual([]);
    expect(codes(good({ customerSituation: { segment: "ENTERPRISE", paymentBehavior: "DELAYED" } }))).toContain("UNSUPPORTED_SEGMENT");
  });

  it("segment: without segment evidence only UNKNOWN is allowed", async () => {
    const w = baseWorld({ customer: { id: "cus_1", organizationId: "org_1", name: "Acme", status: "ACTIVE" } });
    const { good, codes } = await setup(w);
    expect(codes(good({ customerSituation: { segment: "UNKNOWN", paymentBehavior: "DELAYED" } }))).toEqual([]);
    expect(codes(good({ customerSituation: { segment: "SMB", paymentBehavior: "DELAYED" } }))).toContain("UNSUPPORTED_SEGMENT");
  });

  it("behavior: STABLE contradicts risk signals; FAILING needs failed payments", async () => {
    const { good, codes } = await setup();
    expect(codes(good({ customerSituation: { segment: "SMB", paymentBehavior: "STABLE" } }))).toContain("INCONSISTENT_BEHAVIOR");
    const noFail = await setup(baseWorld({ metrics: { overdueAmount: 1200, totalOutstanding: 1200, maxOverdueDays: 45, failedPayments30d: 0, currency: "EUR" }, payments: [{ id: "p", status: "SUCCEEDED", attemptedAt: daysAgo(3), amount: 10 }] }));
    expect(noFail.codes(noFail.good({ customerSituation: { segment: "SMB", paymentBehavior: "FAILING" } }))).toContain("INCONSISTENT_BEHAVIOR");
  });

  it("actions: hold needs severity, NO_ACTION is unsupported with risk signals, dispute forces human review", async () => {
    const { good, codes, anyId } = await setup();
    const act = (type: string) => ({ recommendedAction: { type, priority: "LOW", reason: "x", evidenceIds: [anyId] } });
    expect(codes(good(act("PLACE_ACCOUNT_HOLD")))).toContain("UNSUPPORTED_ACTION"); // 45 days only, no failures / high balance
    expect(codes(good(act("NO_ACTION")))).toContain("UNSUPPORTED_ACTION");
    expect(codes(good(act("SEND_PAYMENT_REMINDER")))).toEqual([]);
    const disputed = await setup(baseWorld({ payments: [{ id: "p1", status: "DISPUTED", attemptedAt: daysAgo(3), amount: 10 }] }));
    const a = (type: string) => ({ recommendedAction: { type, priority: "LOW", reason: "x", evidenceIds: [disputed.anyId] } });
    expect(disputed.codes(disputed.good(a("SEND_PAYMENT_REMINDER")))).toContain("UNSUPPORTED_ACTION");
    expect(disputed.codes(disputed.good(a("REQUEST_HUMAN_REVIEW")))).toEqual([]);
  });

  it("authority: AUTO / APPROVAL / BLOCKED as field or value is rejected anywhere", async () => {
    const { good, codes } = await setup();
    expect(codes({ ...good(), decision: "AUTO" })).toContain("AUTHORITY_DECISION");
    expect(codes(good({ nextBestStep: "decision: BLOCKED" }))).toContain("AUTHORITY_DECISION");
    expect(findAuthorityViolations({ a: { b: ["APPROVAL"] } })).toHaveLength(1);
    expect(findAuthorityViolations({ a: "automatic collection" })).toHaveLength(0);
  });

  it("schema: extra fields, wrong enums and out-of-range confidence are rejected", async () => {
    const { good, codes } = await setup();
    expect(codes({ ...good(), extra: 1 })).toContain("SCHEMA");
    expect(codes(good({ confidence: 1.5 }))).toContain("SCHEMA");
    expect(codes(good({ customerSituation: { segment: "SMB", paymentBehavior: "WEIRD" } }))).toContain("SCHEMA");
  });

  it("parseLlmJson: raw JSON and one fenced block ok; prose, arrays and broken JSON rejected", () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseLlmJson('Here you go: {"a":1}').ok).toBe(false);
    expect(parseLlmJson("[1]").ok).toBe(false);
    expect(parseLlmJson('{"a":').ok).toBe(false);
    expect(parseLlmJson("").ok).toBe(false);
  });
});
