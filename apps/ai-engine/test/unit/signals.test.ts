import { describe, expect, it } from "vitest";
import { CoreApiError } from "../../src/tools/index.js";
import { collect } from "../helpers/context.js";
import { baseWorld, daysAgo, type World } from "../helpers/fakes.js";

const down = (n: number) => new CoreApiError("HTTP_ERROR", "down", n);
/** Only metrics (+ customer/case) are available -> thresholds are tested in isolation. */
const metricsOnly = (m: Record<string, unknown>, over: Partial<World> = {}): World =>
  baseWorld({ metrics: { currency: "EUR", ...m }, fail: { invoices: down(500), payments: down(500), cases: down(500) }, ...over });
const sig = async (w: World) => (await collect(w)).signals;
const codes = async (w: World) => (await sig(w)).map((s) => s.code);

describe("detectSignals thresholds", () => {
  it("overdue age: 29 none, 30 OVERDUE_30 (MEDIUM), 59 no 60, 60 OVERDUE_60 (HIGH), 89 HIGH, 90 CRITICAL", async () => {
    expect(await codes(metricsOnly({ maxOverdueDays: 29, overdueAmount: 10 }))).not.toContain("OVERDUE_30_DAYS");
    const s30 = await sig(metricsOnly({ maxOverdueDays: 30, overdueAmount: 10 }));
    expect(s30.find((s) => s.code === "OVERDUE_30_DAYS")?.severity).toBe("MEDIUM");
    expect(s30.map((s) => s.code)).not.toContain("OVERDUE_60_DAYS");
    expect((await codes(metricsOnly({ maxOverdueDays: 59, overdueAmount: 10 })))).not.toContain("OVERDUE_60_DAYS");
    expect((await sig(metricsOnly({ maxOverdueDays: 60, overdueAmount: 10 }))).find((s) => s.code === "OVERDUE_60_DAYS")?.severity).toBe("HIGH");
    expect((await sig(metricsOnly({ maxOverdueDays: 89, overdueAmount: 10 }))).find((s) => s.code === "OVERDUE_60_DAYS")?.severity).toBe("HIGH");
    expect((await sig(metricsOnly({ maxOverdueDays: 90, overdueAmount: 10 }))).find((s) => s.code === "OVERDUE_60_DAYS")?.severity).toBe("CRITICAL");
  });

  it("overdue balance: 4999.99 none, 5000 HIGH, 25000 CRITICAL", async () => {
    expect(await codes(metricsOnly({ overdueAmount: 4999.99, maxOverdueDays: 5 }))).not.toContain("HIGH_OUTSTANDING_BALANCE");
    expect((await sig(metricsOnly({ overdueAmount: 5000, maxOverdueDays: 5 }))).find((s) => s.code === "HIGH_OUTSTANDING_BALANCE")?.severity).toBe("HIGH");
    expect((await sig(metricsOnly({ overdueAmount: 25000, maxOverdueDays: 5 }))).find((s) => s.code === "HIGH_OUTSTANDING_BALANCE")?.severity).toBe("CRITICAL");
  });

  it("failed payments in 30 days: 1 none, 2 MEDIUM, 3 HIGH", async () => {
    expect(await codes(metricsOnly({ failedPayments30d: 1, overdueAmount: 10, maxOverdueDays: 5 }))).not.toContain("REPEATED_PAYMENT_FAILURE");
    expect((await sig(metricsOnly({ failedPayments30d: 2, overdueAmount: 10, maxOverdueDays: 5 }))).find((s) => s.code === "REPEATED_PAYMENT_FAILURE")?.severity).toBe("MEDIUM");
    expect((await sig(metricsOnly({ failedPayments30d: 3, overdueAmount: 10, maxOverdueDays: 5 }))).find((s) => s.code === "REPEATED_PAYMENT_FAILURE")?.severity).toBe("HIGH");
  });

  it("late payment ratio: 0.5 none, 0.51 MEDIUM, 0.81 HIGH; percent form is normalised; >1 is ignored", async () => {
    expect(await codes(metricsOnly({ latePaymentRatio: 0.5, overdueAmount: 10, maxOverdueDays: 5 }))).not.toContain("HIGH_LATE_PAYMENT_RATIO");
    expect((await sig(metricsOnly({ latePaymentRatio: 0.51, overdueAmount: 10, maxOverdueDays: 5 }))).find((s) => s.code === "HIGH_LATE_PAYMENT_RATIO")?.severity).toBe("MEDIUM");
    expect((await sig(metricsOnly({ latePaymentRatio: 0.81, overdueAmount: 10, maxOverdueDays: 5 }))).find((s) => s.code === "HIGH_LATE_PAYMENT_RATIO")?.severity).toBe("HIGH");
    expect(await codes(metricsOnly({ latePaymentPercent: 90, overdueAmount: 10, maxOverdueDays: 5 }))).toContain("HIGH_LATE_PAYMENT_RATIO");
    expect(await codes(metricsOnly({ latePaymentRatio: 7, overdueAmount: 10, maxOverdueDays: 5 }))).not.toContain("HIGH_LATE_PAYMENT_RATIO");
  });

  it("every signal carries existing evidence ids", async () => {
    const c = await collect(baseWorld({ metrics: { overdueAmount: 30000, totalOutstanding: 30000, maxOverdueDays: 95, failedPayments30d: 4, latePaymentRatio: 0.9, currency: "EUR" }, invoices: [{ id: "inv_1", number: "INV-1", amount: 30000, status: "OPEN", dueDate: daysAgo(95), currency: "EUR" }] }));
    expect(c.signals.length).toBeGreaterThanOrEqual(4);
    for (const s of c.signals) {
      expect(s.evidenceIds.length).toBeGreaterThan(0);
      for (const id of s.evidenceIds) expect(c.store.has(id), `${s.code} -> ${id}`).toBe(true);
    }
  });

  it("payment-history signals: DISPUTED, NO_RECENT_SUCCESSFUL_PAYMENT, REPEATED_PARTIAL_PAYMENT", async () => {
    const disputed = await codes(baseWorld({ payments: [{ id: "p1", status: "DISPUTED", attemptedAt: daysAgo(10), amount: 5 }] }));
    expect(disputed).toContain("DISPUTED_PAYMENT");
    const stale = await codes(baseWorld({ payments: [{ id: "p1", status: "SUCCEEDED", attemptedAt: daysAgo(100), amount: 5 }] }));
    expect(stale).toContain("NO_RECENT_SUCCESSFUL_PAYMENT");
    const fresh = await codes(baseWorld({ payments: [{ id: "p1", status: "SUCCEEDED", attemptedAt: daysAgo(10), amount: 5 }] }));
    expect(fresh).not.toContain("NO_RECENT_SUCCESSFUL_PAYMENT");
    const partial = await codes(baseWorld({ payments: [{ id: "a", status: "PARTIAL", attemptedAt: daysAgo(10), amount: 5 }, { id: "b", status: "PARTIAL", attemptedAt: daysAgo(20), amount: 5 }] }));
    expect(partial).toContain("REPEATED_PARTIAL_PAYMENT");
    const onePartial = await codes(baseWorld({ payments: [{ id: "a", status: "PARTIAL", attemptedAt: daysAgo(10), amount: 5 }] }));
    expect(onePartial).not.toContain("REPEATED_PARTIAL_PAYMENT");
  });

  it("ACCOUNT_ON_HOLD from status or flag; DATA_CONFLICT when metrics and invoices disagree beyond tolerance", async () => {
    expect(await codes(baseWorld({ customer: { id: "cus_1", organizationId: "org_1", segment: "SMB", status: "ON_HOLD" } }))).toContain("ACCOUNT_ON_HOLD");
    expect(await codes(baseWorld({ customer: { id: "cus_1", organizationId: "org_1", segment: "SMB", status: "ACTIVE", onHold: true } }))).toContain("ACCOUNT_ON_HOLD");
    expect(await codes(baseWorld())).not.toContain("DATA_CONFLICT");
    expect(await codes(baseWorld({ metrics: { overdueAmount: 5000, totalOutstanding: 5000, maxOverdueDays: 45, currency: "EUR" } }))).toContain("DATA_CONFLICT");
    // within tolerance (absolute 1) -> no conflict
    expect(await codes(baseWorld({ metrics: { overdueAmount: 1200.5, totalOutstanding: 1200.5, maxOverdueDays: 45, currency: "EUR" } }))).not.toContain("DATA_CONFLICT");
  });

  it("is deterministic: same input -> same output", async () => {
    const a = await sig(baseWorld());
    const b = await sig(baseWorld());
    expect(a).toEqual(b);
  });

  it("minor-unit (cents) amounts are converted", async () => {
    const c = await collect(metricsOnly({ overdueAmountCents: 500000, maxOverdueDays: 5 }));
    expect(c.signals.map((s) => s.code)).toContain("HIGH_OUTSTANDING_BALANCE");
  });
});
