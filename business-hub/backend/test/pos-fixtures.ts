import { randomUUID } from 'node:crypto';
import { Http, auth, makeUser, newTenant } from './helpers';
import { receiveMilk, setupSupplyChain } from './supply-fixtures';

// A trading tenant: two branches, stock of milk at branch 1, a small menu, floor plan, staff and an open shift.
export async function setupPos(http: Http, label: string) {
  const T = await newTenant(http, label);
  const fx = await setupSupplyChain(http, T);
  const post = (path: string, body: object = {}) => http.post(path).set(auth(T.token)).send(body);
  const users = {
    cashier: await makeUser(http, T, 'cash1', 'CASHIER', fx.b1.branchId),
    cashier2: await makeUser(http, T, 'cash2', 'CASHIER', fx.b1.branchId),
    cashierB2: await makeUser(http, T, 'cashb2', 'CASHIER', fx.b2.branchId),
    manager: await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', fx.b1.branchId),
    fin: await makeUser(http, T, 'fin1', 'FINANCE'),
  };
  // opening stock: 10 cartons of milk = 120 l at 1.5 JOD/l into branch 1
  const rec = await receiveMilk(http, T, fx, fx.b1, 10);
  if (rec.outcome !== 'POSTED') throw new Error('opening stock was not posted');

  const latte = (await post('/menu/items', { sku: 'LATTE', name: 'Latte', nameAr: 'لاتيه', price: 2.5, taxCodeId: fx.s16.id, stationKey: 'BAR' }).expect(201)).body;
  const cake = (await post('/menu/items', { sku: 'CAKE', name: 'Cake', price: 3.48, taxCodeId: fx.s16.id, stationKey: 'KITCHEN' }).expect(201)).body;
  const seasonal = (await post('/menu/items', { sku: 'SEAS', name: 'Seasonal', price: 4, taxCodeId: fx.s16.id }).expect(201)).body;
  const largeVariant = (await post(`/menu/items/${latte.id}/variants`, { name: 'Large', priceDelta: 0.5, recipeScale: 1.5 }).expect(201)).body;
  await http.put(`/menu/items/${latte.id}/recipe`).set(auth(T.token)).send({ ingredients: [{ productId: fx.milk.id, qtyBase: 0.25 }] }).expect(200);
  const group = (await post('/menu/modifier-groups', { name: 'Extras', minSelect: 0, maxSelect: 2 }).expect(201)).body;
  const extraMilk = (await post(`/menu/modifier-groups/${group.id}/modifiers`, { name: 'Extra milk', priceDelta: 0.3 }).expect(201)).body;
  await post(`/menu/modifiers/${extraMilk.id}/ingredients`, { productId: fx.milk.id, qtyBase: 0.1 }).expect(201);
  await post(`/menu/items/${latte.id}/modifier-groups`, { groupId: group.id }).expect(201);

  const plan = (await post('/floor/plans', { branchId: fx.b1.branchId, name: 'Main' }).expect(201)).body;
  const table1 = (await post(`/floor/plans/${plan.id}/tables`, { name: 'T1', seats: 4 }).expect(201)).body;
  const shift = (await http.post('/pos/shifts').set(auth(users.cashier.token)).send({ branchId: fx.b1.branchId, openingFloat: 50 }).expect(201)).body;
  return { T, fx, ...users, latte, cake, seasonal, largeVariant, extraMilk, table1, shift };
}

export type PosWorld = Awaited<ReturnType<typeof setupPos>>;

export function posHelpers(http: Http, w: PosWorld) {
  const get = async (path: string, token = w.T.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const key = () => randomUUID();
  const lineLatte = (qty = 2) => ({ menuItemId: w.latte.id, variantId: w.largeVariant.id, modifierIds: [w.extraMilk.id], qty });
  const lineCake = (qty = 1) => ({ menuItemId: w.cake.id, qty });
  const newOrder = async (lines: object[], token = w.cashier.token, extra: object = {}) =>
    (await post('/pos/orders', token, { idempotencyKey: key(), branchId: w.fx.b1.branchId, lines, ...extra }).expect(201)).body;
  const payCash = async (orderId: string, tendered?: number, token = w.cashier.token) =>
    (await post(`/pos/orders/${orderId}/tenders`, token, { idempotencyKey: key(), method: 'CASH', tendered }).expect(201)).body;
  const sellCash = async (lines: object[], token = w.cashier.token) => {
    const o = await newOrder(lines, token);
    await payCash(o.id, undefined, token);
    return (await post(`/pos/orders/${o.id}/complete`, token).expect(201)).body;
  };
  const stock = async (productId: string, locationId = w.fx.b1.locationId) => (await get(`/inventory/stock?productId=${productId}&locationId=${locationId}`))[0] ?? { qtyBase: '0', value: '0' };
  const tb = async (code: string) => (await get('/finance/trial-balance')).rows.find((r: any) => r.code === code) ?? { debit: '0', credit: '0', balance: '0' };
  const journalsFor = (sourceType: string, sourceId: string) => get(`/finance/journals?sourceType=${sourceType}&sourceId=${sourceId}`);
  const byAccount = (j: any) => Object.fromEntries(j.lines.map((l: any) => [l.account.systemKey, [l.debit, l.credit]]));
  return { get, post, key, lineLatte, lineCake, newOrder, payCash, sellCash, stock, tb, journalsFor, byAccount };
}
