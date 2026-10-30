import { Injectable } from '@nestjs/common';

export interface EInvoicePayload {
  schema: 'business-hub/einvoice-draft-v1'; // internal draft shape; the official JoFotara schema is unverified (brief s9.2)
  invoiceNumber: string;
  issueDate: string;
  currency: string;
  seller: { name: string; taxNumber: string | null };
  lines: { name: string; qty: number; unitPrice: string; net: string; taxRate: string; tax: string }[];
  totals: { net: string; tax: string; total: string; discount: string };
  paymentMethods: string[];
}

export interface EInvoiceResult {
  status: 'ACCEPTED' | 'REJECTED';
  reference: string | null;
  reason?: string;
}

// Integration point for the national e-invoicing system. Only the stub exists until official access is confirmed.
export abstract class EInvoiceAdapter {
  abstract submit(payload: EInvoicePayload): Promise<EInvoiceResult>;
}

// Structurally validates the payload and returns a clearly-marked fake reference so nothing is mistaken for an official one.
@Injectable()
export class StubEInvoiceAdapter extends EInvoiceAdapter {
  async submit(p: EInvoicePayload): Promise<EInvoiceResult> {
    if (!p.invoiceNumber || !p.lines.length) return { status: 'REJECTED', reference: null, reason: 'Invoice has no number or no lines' };
    if (!p.seller.taxNumber) return { status: 'REJECTED', reference: null, reason: 'Seller tax number is missing on the legal entity' };
    return { status: 'ACCEPTED', reference: `STUB-${p.invoiceNumber}` };
  }
}

export function buildEInvoicePayload(input: {
  invoice: { number: string; issuedAt: Date; subtotal: string; discountTotal: string; taxTotal: string; total: string };
  lines: { name: string; qty: number; unitPrice: string; net: string; taxRate: string; tax: string }[];
  seller: { name: string; taxNumber: string | null };
  tenders: string[];
}): EInvoicePayload {
  const net = input.lines.reduce((s, l) => s + Number(l.net), 0);
  return {
    schema: 'business-hub/einvoice-draft-v1',
    invoiceNumber: input.invoice.number,
    issueDate: input.invoice.issuedAt.toISOString(),
    currency: 'JOD',
    seller: input.seller,
    lines: input.lines,
    totals: { net: net.toFixed(3), tax: input.invoice.taxTotal, total: input.invoice.total, discount: input.invoice.discountTotal },
    paymentMethods: [...new Set(input.tenders)],
  };
}
