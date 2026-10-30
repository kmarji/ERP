import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useList } from '../lib/lookups';

const TABS = ['Items', 'Variants & modifiers', 'Recipes', 'Costing', 'Price changes'];
const num = (s: string) => (s === '' ? undefined : Number(s));

export default function MenuAdmin() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <div className="space-y-4">
      <PageHeader title="Menu" subtitle="Central catalog with branch overrides. Price changes beyond policy go to approval." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === TABS[0] && <Items />}
      {tab === TABS[1] && <Modifiers />}
      {tab === TABS[2] && <Recipes />}
      {tab === TABS[3] && <Costing />}
      {tab === TABS[4] && <PriceChanges />}
    </div>
  );
}

function Items() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const branches = useList('/org/branches');
  const taxCodes = useList('/tax-codes');
  const categories = useList('/menu/categories');
  const [branchId, setBranchId] = useState('');
  const items = useQuery({ queryKey: ['menu-items', branchId], queryFn: () => api<any[]>(`/menu/items${branchId ? `?branchId=${branchId}` : ''}`) });
  const [msg, setMsg] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['menu-items'] });
  const report = (r: any) => {
    const c = r?.priceChange ?? r;
    setMsg(c?.change ? (c.applied ? 'Price change applied.' : 'Price change needs approval - see Approvals.') : '');
    refresh();
  };
  const toggle = useMutation({ mutationFn: (v: { id: string; available: boolean }) => api(`/menu/branches/${branchId}/items/${v.id}`, { method: 'PUT', body: { available: v.available } }), onSuccess: refresh });
  const [price, setPrice] = useState<Record<string, string>>({});
  const setBranchPrice = useMutation({ mutationFn: (id: string) => api(`/menu/branches/${branchId}/items/${id}`, { method: 'PUT', body: { price: Number(price[id]) } }), onSuccess: report });
  const setCentralPrice = useMutation({ mutationFn: (id: string) => api(`/menu/items/${id}/price`, { method: 'PATCH', body: { price: Number(price[id]) } }), onSuccess: report });
  const [f, setF] = useState({ sku: '', name: '', nameAr: '', price: '', taxCodeId: '', stationKey: '', categoryId: '', isCombo: false });
  const create = useMutation({
    mutationFn: () => api('/menu/items', { body: { ...f, price: Number(f.price), nameAr: f.nameAr || undefined, taxCodeId: f.taxCodeId || undefined, stationKey: f.stationKey || undefined, categoryId: f.categoryId || undefined } }),
    onSuccess: () => { setF({ ...f, sku: '', name: '', nameAr: '', price: '' }); refresh(); },
  });
  return (
    <div className="space-y-6">
      <ErrorBox error={items.error ?? toggle.error ?? setBranchPrice.error ?? setCentralPrice.error ?? create.error} />
      {msg && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{msg}</p>}
      <Card title="Items">
        <div className="mb-3 max-w-xs">
          <Field label="Branch view (enables availability and branch price)">
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Central catalog</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          </Field>
        </div>
        {items.data?.length === 0 ? <Empty>No menu items yet.</Empty> : (
          <Table head={['SKU', 'Name', 'Price', branchId ? 'Effective' : '', 'Available', 'Change price', branchId ? '86' : '']}>
            {items.data?.map((i) => (
              <tr key={i.id}>
                <td className="px-3 py-2 font-mono text-xs">{i.sku}</td>
                <td className="px-3 py-2 font-medium">{i.name} {i.isCombo && <Badge>combo</Badge>}{!i.active && <Badge tone="bg-red-100 text-red-800">inactive</Badge>}</td>
                <td className="px-3 py-2">{formatJOD(i.price, lang)}</td>
                <td className="px-3 py-2">{branchId ? formatJOD(i.effectivePrice, lang) : ''}</td>
                <td className="px-3 py-2">{branchId ? (i.available ? <Badge tone="bg-emerald-100 text-emerald-800">yes</Badge> : <Badge tone="bg-red-100 text-red-800">86'd</Badge>) : ''}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Input className="w-24" type="number" step="0.001" placeholder="JOD" value={price[i.id] ?? ''} onChange={(e) => setPrice({ ...price, [i.id]: e.target.value })} />
                    <Button variant="ghost" disabled={!price[i.id]} onClick={() => setCentralPrice.mutate(i.id)}>Central</Button>
                    {branchId && <Button variant="ghost" disabled={!price[i.id]} onClick={() => setBranchPrice.mutate(i.id)}>Branch</Button>}
                  </div>
                </td>
                <td className="px-3 py-2">{branchId && <Button variant="ghost" onClick={() => toggle.mutate({ id: i.id, available: !i.available })}>{i.available ? '86 it' : 'Restore'}</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="New item (price includes tax)">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
          <Field label="SKU"><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} required /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Name (Arabic)"><Input dir="rtl" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          <Field label="Price (JOD)"><Input type="number" step="0.001" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></Field>
          <Field label="Tax code"><Select value={f.taxCodeId} onChange={(e) => setF({ ...f, taxCodeId: e.target.value })}><option value="">None</option>{taxCodes.data?.map((t) => <option key={t.id} value={t.id}>{t.code} ({Number(t.rate) * 100}%)</option>)}</Select></Field>
          <Field label="Station (e.g. BAR)"><Input value={f.stationKey} onChange={(e) => setF({ ...f, stationKey: e.target.value })} /></Field>
          <Field label="Category"><Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">None</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isCombo} onChange={(e) => setF({ ...f, isCombo: e.target.checked })} />Combo</label>
          <div><Button type="submit">Create item</Button></div>
        </form>
      </Card>
    </div>
  );
}

function Modifiers() {
  const qc = useQueryClient();
  const items = useList('/menu/items');
  const products = useList('/products');
  const groups = useQuery({ queryKey: ['modifier-groups'], queryFn: () => api<any[]>('/menu/modifier-groups') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['modifier-groups'] }); qc.invalidateQueries({ queryKey: ['list', '/menu/items'] }); };
  const [ok, setOk] = useState('');
  const run = (path: string, body: object, after?: () => void) => api(path, { body }).then(() => { setOk('Saved.'); refresh(); after?.(); });
  const m = useMutation({ mutationFn: (v: { path: string; body: object }) => run(v.path, v.body) });
  const [g, setG] = useState({ name: '', minSelect: '0', maxSelect: '1' });
  const [mod, setMod] = useState({ groupId: '', name: '', priceDelta: '0' });
  const [ing, setIng] = useState({ modifierId: '', productId: '', qtyBase: '' });
  const [link, setLink] = useState({ itemId: '', groupId: '' });
  const [v, setV] = useState({ itemId: '', name: '', priceDelta: '0', recipeScale: '1' });
  const [c, setC] = useState({ comboId: '', componentItemId: '', qty: '1' });
  const allModifiers = groups.data?.flatMap((x) => x.modifiers.map((y: any) => ({ ...y, group: x.name }))) ?? [];
  const submit = (fn: () => void) => (e: FormEvent) => { e.preventDefault(); fn(); };
  return (
    <div className="space-y-6">
      <ErrorBox error={m.error ?? groups.error} />
      {ok && !m.error && <p className="text-sm text-emerald-700">{ok}</p>}
      <Card title="Modifier groups">
        {groups.data?.length === 0 ? <Empty>No modifier groups.</Empty> : groups.data?.map((x) => (
          <div key={x.id} className="border-b border-slate-100 py-2 text-sm">
            <b>{x.name}</b> <span className="text-slate-500">pick {x.minSelect}-{x.maxSelect}</span>
            <ul className="ms-4 list-disc text-slate-600">{x.modifiers.map((y: any) => <li key={y.id}>{y.name} (+{y.priceDelta}) {y.ingredients.length > 0 && <span className="text-xs text-slate-400">uses {y.ingredients.map((i: any) => `${i.qtyBase} of ${products.data?.find((p) => p.id === i.productId)?.sku ?? '?'}`).join(', ')}</span>}</li>)}</ul>
          </div>
        ))}
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="New group"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: '/menu/modifier-groups', body: { name: g.name, minSelect: Number(g.minSelect), maxSelect: Number(g.maxSelect) } }))}>
          <Input placeholder="Name" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} required />
          <div className="flex gap-2"><Input type="number" min="0" value={g.minSelect} onChange={(e) => setG({ ...g, minSelect: e.target.value })} /><Input type="number" min="1" value={g.maxSelect} onChange={(e) => setG({ ...g, maxSelect: e.target.value })} /></div>
          <Button type="submit">Add group</Button></form></Card>
        <Card title="New modifier"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: `/menu/modifier-groups/${mod.groupId}/modifiers`, body: { name: mod.name, priceDelta: Number(mod.priceDelta) } }))}>
          <Select value={mod.groupId} onChange={(e) => setMod({ ...mod, groupId: e.target.value })} required><option value="">Group</option>{groups.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          <Input placeholder="Name" value={mod.name} onChange={(e) => setMod({ ...mod, name: e.target.value })} required />
          <Input type="number" step="0.001" placeholder="Price delta" value={mod.priceDelta} onChange={(e) => setMod({ ...mod, priceDelta: e.target.value })} />
          <Button type="submit">Add modifier</Button></form></Card>
        <Card title="Modifier ingredient"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: `/menu/modifiers/${ing.modifierId}/ingredients`, body: { productId: ing.productId, qtyBase: Number(ing.qtyBase) } }))}>
          <Select value={ing.modifierId} onChange={(e) => setIng({ ...ing, modifierId: e.target.value })} required><option value="">Modifier</option>{allModifiers.map((x) => <option key={x.id} value={x.id}>{x.group} / {x.name}</option>)}</Select>
          <Select value={ing.productId} onChange={(e) => setIng({ ...ing, productId: e.target.value })} required><option value="">Product</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} ({p.baseUnit})</option>)}</Select>
          <Input type="number" step="0.0001" placeholder="Qty (base unit)" value={ing.qtyBase} onChange={(e) => setIng({ ...ing, qtyBase: e.target.value })} required />
          <Button type="submit">Add ingredient</Button></form></Card>
        <Card title="Link group to item"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: `/menu/items/${link.itemId}/modifier-groups`, body: { groupId: link.groupId } }))}>
          <Select value={link.itemId} onChange={(e) => setLink({ ...link, itemId: e.target.value })} required><option value="">Item</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
          <Select value={link.groupId} onChange={(e) => setLink({ ...link, groupId: e.target.value })} required><option value="">Group</option>{groups.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          <Button type="submit">Link</Button></form></Card>
        <Card title="New variant"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: `/menu/items/${v.itemId}/variants`, body: { name: v.name, priceDelta: Number(v.priceDelta), recipeScale: Number(v.recipeScale) } }))}>
          <Select value={v.itemId} onChange={(e) => setV({ ...v, itemId: e.target.value })} required><option value="">Item</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
          <Input placeholder="Name (e.g. Large)" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required />
          <div className="flex gap-2"><Input type="number" step="0.001" title="Price delta" value={v.priceDelta} onChange={(e) => setV({ ...v, priceDelta: e.target.value })} /><Input type="number" step="0.01" title="Recipe scale" value={v.recipeScale} onChange={(e) => setV({ ...v, recipeScale: e.target.value })} /></div>
          <Button type="submit">Add variant</Button></form></Card>
        <Card title="Combo component"><form className="space-y-2" onSubmit={submit(() => m.mutate({ path: `/menu/items/${c.comboId}/components`, body: { componentItemId: c.componentItemId, qty: Number(c.qty) } }))}>
          <Select value={c.comboId} onChange={(e) => setC({ ...c, comboId: e.target.value })} required><option value="">Combo item</option>{items.data?.filter((i) => i.isCombo).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
          <Select value={c.componentItemId} onChange={(e) => setC({ ...c, componentItemId: e.target.value })} required><option value="">Contains</option>{items.data?.filter((i) => !i.isCombo).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select>
          <Input type="number" min="1" value={c.qty} onChange={(e) => setC({ ...c, qty: e.target.value })} />
          <Button type="submit">Add component</Button></form></Card>
      </div>
    </div>
  );
}

function Recipes() {
  const items = useList('/menu/items');
  const products = useList('/products');
  const [itemId, setItemId] = useState('');
  const [variantId, setVariantId] = useState('');
  const item = items.data?.find((i) => i.id === itemId);
  const recipe = useQuery({ queryKey: ['recipe', itemId, variantId], queryFn: () => api<any>(`/menu/items/${itemId}/recipe${variantId ? `?variantId=${variantId}` : ''}`), enabled: !!itemId });
  const [rows, setRows] = useState<{ productId: string; qtyBase: string }[]>([]);
  const [yld, setYld] = useState('1');
  useEffect(() => {
    setRows((recipe.data?.ingredients ?? []).map((i: any) => ({ productId: i.productId, qtyBase: String(Number(i.qtyBase)) })));
    setYld(String(Number(recipe.data?.yield ?? 1)));
  }, [recipe.data]);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api(`/menu/items/${itemId}/recipe`, { method: 'PUT', body: { variantId: variantId || undefined, yield: Number(yld), ingredients: rows.filter((r) => r.productId).map((r) => ({ productId: r.productId, qtyBase: Number(r.qtyBase) })) } }),
    onSuccess: () => setSaved(true),
  });
  return (
    <Card title="Recipe (ingredients per yield, in each product's base unit)">
      <ErrorBox error={save.error ?? recipe.error} />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Field label="Item"><Select value={itemId} onChange={(e) => { setItemId(e.target.value); setVariantId(''); setSaved(false); }}><option value="">Choose...</option>{items.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
        <Field label="Variant (blank = base recipe)"><Select value={variantId} onChange={(e) => { setVariantId(e.target.value); setSaved(false); }} disabled={!item}><option value="">Base</option>{item?.variants.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
        <Field label="Yield (portions)"><Input type="number" step="0.001" value={yld} onChange={(e) => setYld(e.target.value)} /></Field>
      </div>
      {itemId && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Select value={r.productId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}><option value="">Product</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} - {p.name} ({p.baseUnit})</option>)}</Select>
              <Input className="w-32" type="number" step="0.0001" value={r.qtyBase} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qtyBase: e.target.value } : x)))} />
              <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setRows([...rows, { productId: '', qtyBase: '' }])}>Add ingredient</Button>
            <Button onClick={() => { setSaved(false); save.mutate(); }}>Save recipe</Button>
            {saved && <span className="text-sm text-emerald-700">Saved.</span>}
          </div>
          {variantId && <p className="text-xs text-slate-400">A variant without its own recipe uses the base recipe scaled by the variant's recipe scale.</p>}
        </div>
      )}
    </Card>
  );
}

function Costing() {
  const { lang } = useI18n();
  const branches = useList('/org/branches');
  const [branchId, setBranchId] = useState('');
  const rows = useQuery({ queryKey: ['costing', branchId], queryFn: () => api<any[]>(`/menu/costing${branchId ? `?branchId=${branchId}` : ''}`) });
  return (
    <Card title="Recipe cost and margin (cost at weighted-average stock cost, price excluding tax)">
      <ErrorBox error={rows.error} />
      <div className="mb-3 max-w-xs"><Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Central prices</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></div>
      {rows.data?.length === 0 ? <Empty>No items.</Empty> : (
        <Table head={['Item', 'Price', 'Net price', 'Recipe cost', 'Margin', 'Margin %']}>
          {rows.data?.map((r) => (
            <tr key={r.menuItemId}>
              <td className="px-3 py-2 font-medium">{r.name} <span className="text-xs text-slate-400">{r.sku}</span></td>
              <td className="px-3 py-2">{formatJOD(r.price, lang)}</td>
              <td className="px-3 py-2">{formatJOD(r.netPrice, lang)}</td>
              <td className="px-3 py-2">{formatJOD(r.cost, lang)} {r.noCost && <Badge tone="bg-amber-100 text-amber-800">incomplete cost</Badge>}</td>
              <td className="px-3 py-2">{formatJOD(r.margin, lang)}</td>
              <td className={`px-3 py-2 ${r.marginPct !== null && Number(r.marginPct) < 30 ? 'font-medium text-red-600' : ''}`}>{r.marginPct === null ? '-' : `${r.marginPct}%`}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function PriceChanges() {
  const { lang } = useI18n();
  const list = useQuery({ queryKey: ['price-changes'], queryFn: () => api<any[]>('/menu/price-changes') });
  const items = useList('/menu/items');
  const branches = useList('/org/branches');
  return (
    <Card title="Price changes">
      <ErrorBox error={list.error} />
      {list.data?.length === 0 ? <Empty>No price changes yet.</Empty> : (
        <Table head={['When', 'Item', 'Scope', 'Old', 'New', 'Change', 'Status']}>
          {list.data?.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2 text-xs text-slate-500">{formatDate(p.createdAt)}</td>
              <td className="px-3 py-2">{items.data?.find((i) => i.id === p.menuItemId)?.name ?? p.menuItemId.slice(0, 8)}</td>
              <td className="px-3 py-2 text-xs">{p.branchId ? branches.data?.find((b) => b.id === p.branchId)?.name : 'Central'}</td>
              <td className="px-3 py-2">{formatJOD(p.oldPrice, lang)}</td>
              <td className="px-3 py-2">{formatJOD(p.newPrice, lang)}</td>
              <td className="px-3 py-2">{Number(p.pct).toFixed(1)}%</td>
              <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
