export interface InvoiceMetricInput {
  amountMinor: number;
  paidAmountMinor: number;
  issuedAt: string;
  dueAt: string;
  paidAt?: string | null;
  status: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'DISPUTED' | 'CANCELLED';
}

export interface PaymentMetricInput {
  amountMinor: number;
  paidAt?: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUNDED' | 'DISPUTED';
}

export interface CustomerMetrics {
  currency: string;
  totalInvoiced: string;
  totalPaid: string;
  totalOutstanding: string;
  overdueOutstanding: string;
  overdueInvoiceCount: number;
  averagePaymentDelayDays: number;
  maxPaymentDelayDays: number;
  paymentSuccessRate: number;
  failedPaymentCount: number;
  failedPaymentRate: number;
  latePaymentRatio: number;
  daysSinceLastSuccessfulPayment: number | null;
  amountAtRisk: string;
}

const validMinor = (value: number) => Number.isSafeInteger(value) && value >= 0;
const toMoney = (minor: bigint) => `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
const daysBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));

/** Financial arithmetic uses integer minor units; returned currency amounts are decimal strings. */
export function calculateCustomerMetrics(input: {
  invoices: InvoiceMetricInput[];
  payments: PaymentMetricInput[];
  now?: Date;
  currency?: string;
}): CustomerMetrics {
  const now = input.now ?? new Date();
  for (const invoice of input.invoices) {
    if (!validMinor(invoice.amountMinor) || !validMinor(invoice.paidAmountMinor) || invoice.paidAmountMinor > invoice.amountMinor ||
      Number.isNaN(Date.parse(invoice.issuedAt)) || Number.isNaN(Date.parse(invoice.dueAt))) {
      throw new Error('Invalid invoice data; customer metrics cannot be calculated safely.');
    }
  }
  for (const payment of input.payments) {
    if (!validMinor(payment.amountMinor) || (payment.paidAt && Number.isNaN(Date.parse(payment.paidAt)))) {
      throw new Error('Invalid payment data; customer metrics cannot be calculated safely.');
    }
  }

  const invoices = input.invoices.filter((invoice) => invoice.status !== 'CANCELLED');
  const totalInvoicedMinor = invoices.reduce((sum, invoice) => sum + BigInt(invoice.amountMinor), 0n);
  const totalPaidMinor = invoices.reduce((sum, invoice) => sum + BigInt(invoice.paidAmountMinor), 0n);
  const overdueInvoices = invoices.filter((invoice) => invoice.status === 'OVERDUE' ||
    (invoice.status !== 'PAID' && Date.parse(invoice.dueAt) < now.getTime()));
  const overdueOutstandingMinor = overdueInvoices.reduce((sum, invoice) => sum + BigInt(invoice.amountMinor - invoice.paidAmountMinor), 0n);
  const paidInvoices = invoices.filter((invoice) => invoice.paidAt && invoice.status === 'PAID');
  const delays = paidInvoices.map((invoice) => daysBetween(new Date(invoice.dueAt), new Date(invoice.paidAt!)));
  const successfulPayments = input.payments.filter((payment) => payment.status === 'SUCCESS');
  const failedPaymentCount = input.payments.filter((payment) => payment.status === 'FAILED').length;
  const settledPayments = successfulPayments.length + failedPaymentCount;
  const latestSuccessfulPayment = successfulPayments
    .filter((payment) => payment.paidAt)
    .map((payment) => Date.parse(payment.paidAt!))
    .reduce<number | null>((latest, timestamp) => latest === null || timestamp > latest ? timestamp : latest, null);
  const lateInvoiceCount = paidInvoices.filter((invoice) => Date.parse(invoice.paidAt!) > Date.parse(invoice.dueAt)).length;

  return {
    currency: input.currency ?? 'EUR',
    totalInvoiced: toMoney(totalInvoicedMinor),
    totalPaid: toMoney(totalPaidMinor),
    totalOutstanding: toMoney(totalInvoicedMinor > totalPaidMinor ? totalInvoicedMinor - totalPaidMinor : 0n),
    overdueOutstanding: toMoney(overdueOutstandingMinor),
    overdueInvoiceCount: overdueInvoices.length,
    averagePaymentDelayDays: delays.length ? Number((delays.reduce((sum, days) => sum + days, 0) / delays.length).toFixed(1)) : 0,
    maxPaymentDelayDays: delays.length ? Math.max(...delays) : 0,
    paymentSuccessRate: settledPayments ? Number((successfulPayments.length / settledPayments).toFixed(4)) : 0,
    failedPaymentCount,
    failedPaymentRate: settledPayments ? Number((failedPaymentCount / settledPayments).toFixed(4)) : 0,
    latePaymentRatio: paidInvoices.length ? Number((lateInvoiceCount / paidInvoices.length).toFixed(4)) : 0,
    daysSinceLastSuccessfulPayment: latestSuccessfulPayment === null ? null : daysBetween(new Date(latestSuccessfulPayment), now),
    amountAtRisk: toMoney(overdueOutstandingMinor),
  };
}
