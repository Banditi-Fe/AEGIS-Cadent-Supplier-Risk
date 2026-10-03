import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, rec: Recorded) => void | Promise<void>;

export interface MockServer {
  url: string;
  port: number;
  requests: Recorded[];
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

/** Real HTTP server on an ephemeral port (no mocks of fetch: the real network stack is exercised). */
export async function startServer(initial: Handler): Promise<MockServer> {
  let handler = initial;
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(rec);
      Promise.resolve(handler(req, res, rec)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A port that is guaranteed to refuse connections. */
export async function closedPort(): Promise<number> {
  const s = await startServer(() => undefined);
  const p = s.port;
  await s.close();
  return p;
}

/** Canonical payloads of the Core API contract (packages/contracts/ai/src/coreApi.ts). */
export function canonicalCore(now: Date) {
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  return {
    case: { id: "case_1", number: "CASE-1", customerId: "cus_1", organizationId: "org_1", status: "OPEN", type: "OVERDUE", openedAt: daysAgo(2) },
    customer: { id: "cus_1", organizationId: "org_1", name: "Acme", segment: "SMB", status: "ACTIVE", createdAt: daysAgo(400) },
    metrics: { overdueAmount: 1200, totalOutstanding: 1200, maxOverdueDays: 45, failedPayments30d: 1, latePaymentRatio: 0.2, overdueInvoiceCount: 1, currency: "EUR" },
    invoices: [{ id: "inv_1", number: "INV-1", amount: 1200, amountOutstanding: 1200, status: "OPEN", dueDate: daysAgo(45), currency: "EUR" }],
    payments: [{ id: "pay_1", status: "FAILED", amount: 1200, attemptedAt: daysAgo(5) }],
    cases: [{ id: "case_0", status: "CLOSED", openedAt: daysAgo(200), outcome: "paid" }],
  };
}

/** Core API mock that answers every /internal/v1/* endpoint with canonical payloads. */
export const coreHandler = (now: Date, over: Partial<ReturnType<typeof canonicalCore>> = {}): Handler => {
  const d = { ...canonicalCore(now), ...over };
  return (req, res) => {
    const u = req.url ?? "";
    if (u.endsWith("/metrics")) return json(res, 200, d.metrics);
    if (u.endsWith("/invoices")) return json(res, 200, d.invoices);
    if (u.endsWith("/payments")) return json(res, 200, d.payments);
    if (u.endsWith("/cases")) return json(res, 200, d.cases);
    if (u.includes("/internal/v1/cases/")) return json(res, 200, d.case);
    if (u.includes("/internal/v1/customers/")) return json(res, 200, d.customer);
    return json(res, 404, { error: "nope" });
  };
};
