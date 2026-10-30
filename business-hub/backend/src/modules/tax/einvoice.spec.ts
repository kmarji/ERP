import { buildEInvoicePayload, StubEInvoiceAdapter } from './einvoice';

const payload = (taxNumber: string | null = '123456') =>
  buildEInvoicePayload({
    invoice: { number: 'SI-000001', issuedAt: new Date('2026-10-30T10:00:00Z'), subtotal: '10.080', discountTotal: '0', taxTotal: '1.390', total: '10.080' },
    lines: [{ name: 'Latte', qty: 2, unitPrice: '3.300', net: '5.690', taxRate: '0.16', tax: '0.910' }, { name: 'Cake', qty: 1, unitPrice: '3.480', net: '3.000', taxRate: '0.16', tax: '0.480' }],
    seller: { name: 'Demo', taxNumber },
    tenders: ['CASH', 'CASH'],
  });

describe('e-invoice draft', () => {
  it('builds a payload with net total and de-duplicated payment methods', () => {
    const p = payload();
    expect(p.totals).toEqual({ net: '8.690', tax: '1.390', total: '10.080', discount: '0' });
    expect(p.paymentMethods).toEqual(['CASH']);
  });

  it('stub accepts a complete invoice with a clearly fake reference and rejects missing seller tax number', async () => {
    const a = new StubEInvoiceAdapter();
    expect(await a.submit(payload())).toEqual({ status: 'ACCEPTED', reference: 'STUB-SI-000001' });
    expect(await a.submit(payload(null))).toMatchObject({ status: 'REJECTED', reason: expect.stringContaining('tax number') });
  });
});
