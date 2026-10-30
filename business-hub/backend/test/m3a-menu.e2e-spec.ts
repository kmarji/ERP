import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { MenuService } from '../src/modules/menu/menu.service';
import { Decimal } from '../src/common/money';
import { Http, auth, createApp, makeUser, newTenant } from './helpers';
import { receiveMilk, setupSupplyChain } from './supply-fixtures';

describe('M3-A Menu, recipes, price policy, costing', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let fx: Awaited<ReturnType<typeof setupSupplyChain>>;
  let fin1: { id: string; token: string };
  let mgr1: { id: string; token: string };
  let mgr2: { id: string; token: string };
  let kitchen1: { id: string; token: string };
  let cashier1: { id: string; token: string };
  let latte: any;
  let large: any;
  let shot: any;
  let cookie: any;
  let combo: any;
  let shotGroup: any;

  const get = async (path: string, token = T.token) => (await http.get(path).set(auth(token)).expect(200)).body;
  const asTenant = <R>(fn: () => Promise<R>) => runWithTenant(T.tenantId, fn);
  const resolve = (input: any) => asTenant(() => app.get(MenuService).resolveLine({ branchId: fx.b1.branchId, ...input }));
  const consume = (input: any) =>
    asTenant(async () => Object.fromEntries((await app.get(MenuService).consumptionFor(input)).map((c) => [c.productId, c.qtyBase.toString()])));

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp());
    T = await newTenant(http, 'm3a');
    fx = await setupSupplyChain(http, T);
    fin1 = await makeUser(http, T, 'fin1', 'FINANCE');
    mgr1 = await makeUser(http, T, 'mgr1', 'BRANCH_MANAGER', fx.b1.branchId);
    mgr2 = await makeUser(http, T, 'mgr2', 'BRANCH_MANAGER', fx.b2.branchId);
    kitchen1 = await makeUser(http, T, 'kit1', 'KITCHEN', fx.b1.branchId);
    cashier1 = await makeUser(http, T, 'cash1', 'CASHIER', fx.b1.branchId);

    const cat = (await http.post('/menu/categories').set(auth(T.token)).send({ name: 'Coffee' }).expect(201)).body;
    latte = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'LATTE', name: 'Latte', categoryId: cat.id, price: 2.5, taxCodeId: fx.s16.id, stationKey: 'BAR' }).expect(201)).body;
    large = (await http.post(`/menu/items/${latte.id}/variants`).set(auth(T.token)).send({ name: 'Large', priceDelta: 0.5, recipeScale: 1.5 }).expect(201)).body;
    shotGroup = (await http.post('/menu/modifier-groups').set(auth(T.token)).send({ name: 'Extras', minSelect: 0, maxSelect: 1 }).expect(201)).body;
    shot = (await http.post(`/menu/modifier-groups/${shotGroup.id}/modifiers`).set(auth(T.token)).send({ name: 'Extra shot', priceDelta: 0.7 }).expect(201)).body;
    await http.post(`/menu/modifiers/${shot.id}/ingredients`).set(auth(T.token)).send({ productId: fx.flour.id, qtyBase: 0.02 }).expect(201);
    await http.post(`/menu/items/${latte.id}/modifier-groups`).set(auth(T.token)).send({ groupId: shotGroup.id }).expect(201);
    // 0.4 l of milk makes 2 lattes
    await http.put(`/menu/items/${latte.id}/recipe`).set(auth(T.token)).send({ yield: 2, ingredients: [{ productId: fx.milk.id, qtyBase: 0.4 }] }).expect(200);

    cookie = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'COOKIE', name: 'Cookie', price: 1.2, taxCodeId: fx.s16.id }).expect(201)).body;
    await http.put(`/menu/items/${cookie.id}/recipe`).set(auth(T.token)).send({ ingredients: [{ productId: fx.flour.id, qtyBase: 0.1 }] }).expect(200);
    combo = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'COMBO', name: 'Latte combo', price: 3.2, taxCodeId: fx.s16.id, isCombo: true }).expect(201)).body;
    await http.post(`/menu/items/${combo.id}/components`).set(auth(T.token)).send({ componentItemId: latte.id, qty: 2 }).expect(201);
    await http.post(`/menu/items/${combo.id}/components`).set(auth(T.token)).send({ componentItemId: cookie.id }).expect(201);
  });

  afterAll(() => app.close());

  it('prices tax-inclusive lines from item, variant, modifiers and branch override', async () => {
    const base = await resolve({ menuItemId: latte.id });
    expect(base).toMatchObject({ name: 'Latte', stationKey: 'BAR', variantId: null, modifiers: [] });
    expect(base.unitPrice.toString()).toBe('2.5');
    expect(base.taxRate.toString()).toBe('0.16');

    const full = await resolve({ menuItemId: latte.id, variantId: large.id, modifierIds: [shot.id] });
    expect(full.unitPrice.toString()).toBe('3.7'); // 2.5 + 0.5 + 0.7
    expect(full.modifiers).toEqual([{ id: shot.id, name: 'Extra shot', priceDelta: '0.7' }]);
  });

  it('enforces variant ownership and modifier rules (min/max, membership, active)', async () => {
    const other = (await http.post(`/menu/items/${cookie.id}/variants`).set(auth(T.token)).send({ name: 'Box' }).expect(201)).body;
    await expect(resolve({ menuItemId: latte.id, variantId: other.id })).rejects.toThrow(/Variant does not belong/);
    await expect(resolve({ menuItemId: latte.id, modifierIds: [shot.id, shot.id] })).rejects.toThrow(/at most 1/);
    await expect(resolve({ menuItemId: cookie.id, modifierIds: [shot.id] })).rejects.toThrow(/not offered/);

    const req = (await http.post('/menu/modifier-groups').set(auth(T.token)).send({ name: 'Milk type', minSelect: 1, maxSelect: 1 }).expect(201)).body;
    const oat = (await http.post(`/menu/modifier-groups/${req.id}/modifiers`).set(auth(T.token)).send({ name: 'Oat', priceDelta: 0.4 }).expect(201)).body;
    const soy = (await http.post(`/menu/modifier-groups/${req.id}/modifiers`).set(auth(T.token)).send({ name: 'Soy' }).expect(201)).body;
    const tea = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'TEA', name: 'Tea', price: 1 }).expect(201)).body;
    await http.post(`/menu/items/${tea.id}/modifier-groups`).set(auth(T.token)).send({ groupId: req.id }).expect(201);
    await expect(resolve({ menuItemId: tea.id })).rejects.toThrow(/at least 1/);
    expect((await resolve({ menuItemId: tea.id, modifierIds: [oat.id] })).unitPrice.toString()).toBe('1.4');
    await prisma.raw.modifier.update({ where: { id: soy.id }, data: { active: false } });
    await expect(resolve({ menuItemId: tea.id, modifierIds: [soy.id] })).rejects.toThrow(/not active/);
  });

  it('honours scheduled windows in Amman time, including windows that wrap midnight', async () => {
    const breakfast = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'BRK', name: 'Breakfast', price: 4, availableFrom: '06:00', availableTo: '11:00' }).expect(201)).body;
    const night = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'NGT', name: 'Late snack', price: 3, availableFrom: '22:00', availableTo: '02:00' }).expect(201)).body;
    await http.post('/menu/items').set(auth(T.token)).send({ sku: 'BAD', name: 'Bad', price: 1, availableFrom: '25:00' }).expect(400);
    // Amman is UTC+3
    await expect(resolve({ menuItemId: breakfast.id, at: new Date('2026-03-01T05:00:00Z') })).resolves.toBeDefined(); // 08:00
    await expect(resolve({ menuItemId: breakfast.id, at: new Date('2026-03-01T09:00:00Z') })).rejects.toThrow(/only served 06:00-11:00/); // 12:00
    await expect(resolve({ menuItemId: night.id, at: new Date('2026-03-01T20:00:00Z') })).resolves.toBeDefined(); // 23:00
    await expect(resolve({ menuItemId: night.id, at: new Date('2026-03-01T22:30:00Z') })).resolves.toBeDefined(); // 01:30
    await expect(resolve({ menuItemId: night.id, at: new Date('2026-03-01T12:00:00Z') })).rejects.toThrow(/only served/); // 15:00
  });

  it('computes ingredient consumption from recipe yield, variant scale, modifiers and combos', async () => {
    expect(await consume({ menuItemId: latte.id, qty: 1 })).toEqual({ [fx.milk.id]: '0.2' });
    // large uses the base recipe scaled x1.5: 0.4/2*3*1.5 = 0.9 l, plus 3 extra shots of 0.02 kg
    expect(await consume({ menuItemId: latte.id, variantId: large.id, modifierIds: [shot.id], qty: 3 })).toEqual({ [fx.milk.id]: '0.9', [fx.flour.id]: '0.06' });
    // combo of 2 lattes + 1 cookie, sold twice: 4 lattes (0.8 l) and 2 cookies (0.2 kg)
    expect(await consume({ menuItemId: combo.id, qty: 2 })).toEqual({ [fx.milk.id]: '0.8', [fx.flour.id]: '0.2' });
    const noRecipe = (await http.post('/menu/items').set(auth(T.token)).send({ sku: 'WATER', name: 'Water', price: 0.5 }).expect(201)).body;
    expect(await consume({ menuItemId: noRecipe.id, qty: 5 })).toEqual({});

    // an explicit variant recipe is used as written, not scaled again
    await http.put(`/menu/items/${latte.id}/recipe`).set(auth(T.token)).send({ variantId: large.id, ingredients: [{ productId: fx.milk.id, qtyBase: 0.35 }] }).expect(200);
    expect(await consume({ menuItemId: latte.id, variantId: large.id, qty: 2 })).toEqual({ [fx.milk.id]: '0.7' });
    expect((await get(`/menu/items/${latte.id}/recipe?variantId=${large.id}`)).ingredients).toHaveLength(1);
  });

  it('availability: kitchen can 86 an item at its own branch only; other branches are unaffected', async () => {
    await http.put(`/menu/branches/${fx.b1.branchId}/items/${latte.id}`).set(auth(kitchen1.token)).send({ available: false }).expect(200);
    await expect(resolve({ menuItemId: latte.id })).rejects.toThrow(/unavailable at this branch/);
    await expect(asTenant(() => app.get(MenuService).resolveLine({ menuItemId: latte.id, branchId: fx.b2.branchId }))).resolves.toBeDefined();
    const listed = (await get(`/menu/items?branchId=${fx.b1.branchId}`, cashier1.token)).find((i: any) => i.id === latte.id);
    expect(listed).toMatchObject({ available: false, effectivePrice: '2.5' });

    await http.put(`/menu/branches/${fx.b2.branchId}/items/${latte.id}`).set(auth(kitchen1.token)).send({ available: false }).expect(403);
    await http.put(`/menu/branches/${fx.b1.branchId}/items/${latte.id}`).set(auth(kitchen1.token)).send({ price: 2 }).expect(403); // kitchen cannot change prices
    await http.put(`/menu/branches/${fx.b1.branchId}/items/${latte.id}`).set(auth(cashier1.token)).send({ available: true }).expect(403);
    await http.put(`/menu/branches/${fx.b1.branchId}/items/${latte.id}`).set(auth(mgr1.token)).send({ available: true }).expect(200);
    await expect(resolve({ menuItemId: latte.id })).resolves.toBeDefined();
    const audit = await get('/audit?action=menu.item_');
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['menu.item_86', 'menu.item_available']));
  });

  it('small price changes apply at once; large ones need an approver; rejected ones change nothing', async () => {
    // central price, 2% move: auto
    const small = (await http.patch(`/menu/items/${latte.id}/price`).set(auth(fin1.token)).send({ price: 2.55 }).expect(200)).body;
    expect(small.applied).toBe(true);
    expect(small.change).toMatchObject({ status: 'APPLIED', oldPrice: '2.5', newPrice: '2.55' });
    expect((await resolve({ menuItemId: latte.id })).unitPrice.toString()).toBe('2.55');
    await http.patch(`/menu/items/${latte.id}/price`).set(auth(mgr1.token)).send({ price: 3 }).expect(403); // central catalog is finance/owner only

    // branch override by the manager: 15% jump needs finance
    const big = (await http.put(`/menu/branches/${fx.b1.branchId}/items/${latte.id}`).set(auth(mgr1.token)).send({ price: 3 }).expect(200)).body;
    expect(big.priceChange.applied).toBe(false);
    expect(big.priceChange.change).toMatchObject({ status: 'PENDING', branchId: fx.b1.branchId });
    expect((await resolve({ menuItemId: latte.id })).unitPrice.toString()).toBe('2.55'); // unchanged while pending
    const approval = (await get('/approvals', fin1.token)).find((a: any) => a.subjectId === big.priceChange.change.id);
    expect(approval).toMatchObject({ action: 'menu.apply_price', approverRole: 'FINANCE', branchId: fx.b1.branchId });
    await http.post(`/approvals/${approval.id}/decide`).set(auth(mgr1.token)).send({ approve: true }).expect(403); // requester has no finance role
    await http.post(`/approvals/${approval.id}/decide`).set(auth(fin1.token)).send({ approve: true }).expect(201);
    expect((await resolve({ menuItemId: latte.id })).unitPrice.toString()).toBe('3');
    expect((await asTenant(() => app.get(MenuService).resolveLine({ menuItemId: latte.id, branchId: fx.b2.branchId }))).unitPrice.toString()).toBe('2.55');
    expect((await get('/menu/price-changes')).filter((c: any) => c.status === 'APPLIED')).toHaveLength(2);

    // rejected change leaves the price alone
    const rej = (await http.put(`/menu/branches/${fx.b2.branchId}/items/${latte.id}`).set(auth(mgr2.token)).send({ price: 5 }).expect(200)).body;
    const a2 = (await get('/approvals', fin1.token)).find((a: any) => a.subjectId === rej.priceChange.change.id);
    await http.post(`/approvals/${a2.id}/decide`).set(auth(fin1.token)).send({ approve: false, comment: 'too high' }).expect(201);
    expect((await get('/menu/price-changes')).find((c: any) => c.id === rej.priceChange.change.id).status).toBe('REJECTED');
    expect((await asTenant(() => app.get(MenuService).resolveLine({ menuItemId: latte.id, branchId: fx.b2.branchId }))).unitPrice.toString()).toBe('2.55');
  });

  it('costing uses weighted-average stock cost and flags items without cost history', async () => {
    await receiveMilk(http, T, fx, fx.b1, 10); // 120 l for 180 JOD = 1.5 per l
    const rows = await get('/menu/costing');
    const row = (sku: string) => rows.find((r: any) => r.sku === sku);
    expect(row('LATTE')).toMatchObject({ price: '2.55', taxRate: '0.16', netPrice: '2.198', cost: '0.3', noCost: false, margin: '1.898' });
    expect(row('LATTE').marginPct).toBe('86.35');
    expect(row('COOKIE')).toMatchObject({ cost: '0', noCost: true }); // flour has never been stocked
    expect(row('COMBO')).toMatchObject({ noCost: true });
    const b1 = (await get(`/menu/costing?branchId=${fx.b1.branchId}`)).find((r: any) => r.sku === 'LATTE');
    expect(b1.price).toBe('3'); // branch override is reflected
    await http.get('/menu/costing').set(auth(cashier1.token)).expect(403);
  });

  it('offline bundle carries effective branch prices, availability and a price version', async () => {
    const b1 = await get(`/menu/offline-bundle/${fx.b1.branchId}`, cashier1.token);
    const b2 = await get(`/menu/offline-bundle/${fx.b2.branchId}`, cashier1.token);
    const item = (b: any) => b.items.find((i: any) => i.sku === 'LATTE');
    expect(item(b1)).toMatchObject({ price: '3', taxRate: '0.16', available: true });
    expect(item(b2).price).toBe('2.55');
    expect(item(b1).variants[0]).toMatchObject({ name: 'Large', priceDelta: '0.5' });
    expect(item(b1).modifierGroups[0].modifiers[0]).toMatchObject({ name: 'Extra shot', priceDelta: '0.7' });
    expect(b1.priceVersion).not.toBe(b2.priceVersion);
    expect(b1.taxInclusive).toBe(true);
  });

  it('actual-vs-theoretical separates recipe usage, wastage and unexplained shrinkage', async () => {
    const loc = fx.b1.locationId;
    await asTenant(() =>
      prisma.db.$transaction(async (tx) => {
        const inv = app.get(InventoryService);
        const mv = (type: any, qty: number, key: string) =>
          inv.applyMovement(tx, { productId: fx.milk.id, locationId: loc, type, qtyBase: new Decimal(qty), sourceType: 'Test', sourceId: key, idempotencyKey: `${key}:${randomUUID()}` });
        await mv('SALE_CONSUMPTION', -30, 'sale');
        await mv('WASTAGE', -6, 'waste');
        await mv('COUNT_ADJUSTMENT', -6, 'count');
      }),
    );
    const r = await get(`/inventory/reports/actual-vs-theoretical?locationId=${loc}`);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      sku: 'MILK',
      theoreticalUsage: '30',
      wastage: '6',
      countVariance: '-6',
      actualUsage: '42',
      unexplained: '6',
      unexplainedPct: '20',
      theoreticalValue: '45',
      wastageValue: '9',
      countVarianceValue: '-9',
      actualUsageValue: '63',
    });
    await http.get('/inventory/reports/actual-vs-theoretical').set(auth(cashier1.token)).expect(403);
    expect(await get('/inventory/reconcile')).toMatchObject({ consistent: true });
  });
});
