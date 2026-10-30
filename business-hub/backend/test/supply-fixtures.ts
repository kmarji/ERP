import { randomUUID } from 'node:crypto';
import { Http, auth, today } from './helpers';

// Shared supply-chain fixtures for later milestones: two branches (one legal entity), milk and flour, one supplier.
export async function setupSupplyChain(http: Http, T: { token: string }) {
  const get = async (path: string) => (await http.get(path).set(auth(T.token)).expect(200)).body;
  const le = (await get('/org/legal-entities'))[0];
  const mkBranch = async (code: string) => {
    const b = (await http.post('/org/branches').set(auth(T.token)).send({ legalEntityId: le.id, code, name: code }).expect(201)).body;
    const l = (await http.post('/org/stock-locations').set(auth(T.token)).send({ branchId: b.id, code: `${code}-MAIN`, name: `${code} store` }).expect(201)).body;
    return { branchId: b.id as string, locationId: l.id as string };
  };
  const b1 = await mkBranch('B1');
  const b2 = await mkBranch('B2');
  const s16 = (await get('/tax-codes')).find((t: any) => t.code === 'S16');
  const milk = (await http.post('/products').set(auth(T.token)).send({ sku: 'MILK', name: 'Milk', baseUnit: 'l', taxCodeId: s16.id }).expect(201)).body;
  await http.post(`/products/${milk.id}/conversions`).set(auth(T.token)).send({ unit: 'carton', factorToBase: 12 }).expect(201);
  const flour = (await http.post('/products').set(auth(T.token)).send({ sku: 'FLOUR', name: 'Flour', baseUnit: 'kg', taxCodeId: s16.id }).expect(201)).body;
  const supplier = (await http.post('/suppliers').set(auth(T.token)).send({ name: 'Dairy Co', taxNumber: 'JO-111' }).expect(201)).body;
  await http.post(`/suppliers/${supplier.id}/items`).set(auth(T.token)).send({ productId: milk.id, supplierSku: 'D-MILK', unit: 'carton', agreedPrice: 18, preferred: true }).expect(201);
  return { le, b1, b2, milk, flour, supplier, s16 };
}

let invoiceSeq = 0;

// Receives `cartons` of milk (18 JOD each) into a location through the real receiving flow.
export async function receiveMilk(http: Http, T: { token: string }, fx: Awaited<ReturnType<typeof setupSupplyChain>>, loc: { branchId: string; locationId: string }, cartons: number, token = T.token) {
  const po = (await http.post('/purchase-orders').set(auth(token)).send({ supplierId: fx.supplier.id, branchId: loc.branchId, stockLocationId: loc.locationId, lines: [{ productId: fx.milk.id, qty: cartons, unit: 'carton' }] }).expect(201)).body;
  const net = cartons * 18;
  const tax = +(net * 0.16).toFixed(3);
  const number = `INV-FX-${++invoiceSeq}-${randomUUID().slice(0, 4)}`;
  const fixture = {
    confidence: 0.98,
    qr: `QR-${number}`,
    fields: { invoiceNumber: number, invoiceDate: today(), supplierTaxNumber: 'JO-111', subtotal: net, taxTotal: tax, total: +(net + tax).toFixed(3), qrUuid: `QR-${number}` },
    lines: [{ supplierSku: 'D-MILK', qty: cartons, unit: 'carton', unitPrice: 18, taxRate: 0.16 }],
  };
  const doc = (await http.post('/documents').set(auth(token)).attach('file', Buffer.from(JSON.stringify(fixture)), { filename: 'i.json', contentType: 'application/json' }).expect(201)).body.id;
  const res = await http.post('/receiving').set(auth(token)).send({ idempotencyKey: randomUUID(), purchaseOrderId: po.id, branchId: loc.branchId, stockLocationId: loc.locationId, evidenceDocumentId: doc, receivedLines: [{ poLineId: po.lines[0].id, qty: cartons }] }).expect(201);
  return { po, ...res.body };
}
