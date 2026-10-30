import { uuid } from '../lib/uuid';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CartLine, ItemDialog } from '../components/ItemDialog';
import { useOverride } from '../components/Override';
import { Receipt, ReceiptData } from '../components/Receipt';
import { Btn, Chip, Err } from '../components/ui';
import { api, newKey } from '../lib/api';
import { fmt, num } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { MenuItem, useMenu } from '../lib/menu';
import { getBundle, queueSale, useNet } from '../lib/offline';
import { useSession } from '../lib/session';
import { CashOfflineDialog, CustomerPicker, DiscountDialog, SplitDialog, TablePicker } from './OrderDialogs';

const CHANNELS = ['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'] as const;
type Channel = (typeof CHANNELS)[number];
const OFFLINE_CHANNELS: Channel[] = ['DINE_IN', 'TAKEAWAY', 'PICKUP'];

const toLine = (l: CartLine) => ({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: l.modifiers.map((m) => m.id), qty: l.qty, notes: l.notes });

export default function OrderPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { t, nameOf } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const override = useOverride();
  const offline = !net.online;

  const menu = useMenu(branch!.id, offline);
  const order = useQuery({ queryKey: ['order', id], queryFn: () => api<any>(`/pos/orders/${id}`), enabled: !!id && !offline });
  const bundle = useQuery({ queryKey: ['bundle'], queryFn: getBundle, enabled: offline });

  const [cart, setCart] = useState<CartLine[]>([]);
  const [draftKey] = useState(newKey);
  const [channel, setChannel] = useState<Channel>('DINE_IN');
  const [table, setTable] = useState<{ id: string; name: string } | null>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string; points: number } | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [item, setItem] = useState<MenuItem | null>(null);
  const [dialog, setDialog] = useState<'table' | 'customer' | 'discount' | 'split' | 'cash' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [provisional, setProvisional] = useState<ReceiptData | null>(null);

  const o = order.data;
  const serverLines: any[] = o?.lines.filter((l: any) => !l.voided) ?? [];
  const cartTotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const effChannel: Channel = o?.channel ?? channel;
  const cats = menu.data?.categories ?? [];
  const items = useMemo(() => (menu.data?.items ?? []).filter((i) => cat === null || i.categoryId === cat), [menu.data, cat]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['order', id] });

  // Saves unsaved items to the server (creating the order the first time) and returns its id.
  // The draft key makes a retried create return the same order instead of a duplicate.
  async function flush(): Promise<string> {
    if (!id) {
      const created = await api<any>('/pos/orders', { body: { idempotencyKey: draftKey, branchId: branch!.id, channel, tableId: table?.id, customerId: customer?.id, lines: cart.map(toLine) } });
      setCart([]);
      nav(`/order/${created.id}`, { replace: true });
      return created.id;
    }
    if (cart.length) {
      await api(`/pos/orders/${id}/lines`, { body: { lines: cart.map(toLine) } });
      setCart([]);
      await refresh();
    }
    return id;
  }

  async function act(fn: (orderId: string) => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const orderId = await flush();
      await fn(orderId);
      await qc.invalidateQueries({ queryKey: ['order', orderId] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // Quantity can be changed on lines the kitchen has not received yet (the server answers 409 once sent).
  const setQty = async (lineId: string, qty: number) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/pos/orders/${id}/lines/${lineId}/qty`, { body: { qty } });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const voidLine = async (lineId: string) => {
    setBusy(true);
    setError(null);
    try {
      await override((ov) => api(`/pos/orders/${id}/lines/${lineId}/void`, { body: { reason: 'Removed by cashier', override: ov } }));
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  async function sellOffline(tendered: number) {
    const sale = { clientOrderId: uuid(), channel: effChannel === 'DELIVERY' ? 'TAKEAWAY' : effChannel, tableId: effChannel === 'DINE_IN' ? table?.id : undefined, lines: cart.map((l) => ({ ...toLine(l), unitPrice: l.unitPrice })), tenders: [{ method: 'CASH', tendered }] };
    const op = await queueSale(sale, { total: cartTotal, localNumber: `OFF-${uuid().slice(0, 6).toUpperCase()}` });
    const taxes = new Map<number, { net: number; tax: number }>();
    for (const l of cart) {
      const tot = l.unitPrice * l.qty;
      const tax = (tot * l.taxRate) / (1 + l.taxRate);
      const cur = taxes.get(l.taxRate) ?? { net: 0, tax: 0 };
      taxes.set(l.taxRate, { net: cur.net + tot - tax, tax: cur.tax + tax });
    }
    setProvisional({
      invoiceNumber: null,
      orderNumber: op.localNumber,
      issuedAt: op.capturedAt,
      provisional: true,
      seller: { name: branch!.name, branch: branch!.name },
      lines: cart.map((l) => ({ name: `${l.name}${l.variantName ? ` (${l.variantName})` : ''}`, nameAr: l.nameAr, qty: l.qty, unitPrice: l.unitPrice, modifiers: l.modifiers, total: l.unitPrice * l.qty })),
      subtotal: cartTotal,
      discount: 0,
      total: cartTotal,
      taxBreakdown: [...taxes].map(([r, v]) => ({ ratePct: String(r * 100), net: v.net.toFixed(3), tax: v.tax.toFixed(3) })),
      tenders: [{ method: 'CASH', amount: cartTotal, tendered, change: tendered - cartTotal }],
    });
    setCart([]);
    setDialog(null);
  }

  if (provisional) return <div className="p-6"><Receipt r={provisional} onDone={() => setProvisional(null)} /></div>;
  if (o && ['COMPLETED', 'VOIDED'].includes(o.status)) return <div className="p-8 text-center text-xl">Order {o.number} is {o.status.toLowerCase()}. <Btn className="ml-4" onClick={() => nav('/pay/' + o.id)}>{t('Receipt')}</Btn></div>;

  const blocked = bundle.data?.capabilities.blocked ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col">
        {offline && (
          <div className="mb-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            <b>Offline sale.</b> Only cash sales for dine-in, takeaway and pickup can be taken. {blocked.map((b) => `${b.action}: ${b.why}`).join(' - ')}
          </div>
        )}
        <div className="mb-2 flex flex-wrap gap-2">
          {CHANNELS.map((c) => <Chip key={c} on={effChannel === c} disabled={!!id || (offline && !OFFLINE_CHANNELS.includes(c))} onClick={() => setChannel(c)}>{t(c.charAt(0) + c.slice(1).toLowerCase())}</Chip>)}
          {effChannel === 'DINE_IN' && <Chip on={!!table || !!o?.tableId} onClick={() => setDialog('table')}>{t('Table')}: {table?.name ?? (o?.tableId ? 'set' : '-')}</Chip>}
        </div>
        <div className="mb-2 flex gap-2 overflow-x-auto">
          <Chip on={cat === null} onClick={() => setCat(null)}>All</Chip>
          {cats.map((c) => <Chip key={c.id} on={cat === c.id} onClick={() => setCat(c.id)}>{nameOf(c)}</Chip>)}
        </div>
        <Err error={menu.error} />
        <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-auto sm:grid-cols-3 xl:grid-cols-4">
          {items.map((i) => (
            <button key={i.id} disabled={!i.available} onClick={() => setItem(i)} className="min-h-24 rounded-2xl border border-slate-300 bg-white p-3 text-left active:bg-brand-50 disabled:bg-slate-200 disabled:text-slate-400">
              <div className="text-lg font-semibold leading-tight">{nameOf(i)}</div>
              <div className="mt-1 text-slate-600">{fmt(i.price)}{!i.available && ' - unavailable'}</div>
            </button>
          ))}
        </div>
      </section>

      <aside className="flex min-h-0 w-full flex-col rounded-2xl bg-white p-3 shadow lg:w-96">
        <div className="mb-2 flex items-center justify-between text-lg">
          <b>{o ? o.number : t('New order')}</b>
          <span className="text-sm text-slate-500">{customer?.name ?? ''}</span>
        </div>
        <Err error={error} />
        <div className="flex-1 space-y-2 overflow-auto">
          {serverLines.map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-xl border p-2">
              <div className="min-w-0">
                <div className="truncate">{l.qty} x {nameOf(l)} {l.sentAt && <span className="text-xs text-emerald-600">sent</span>}</div>
                <div className="text-xs text-slate-500">{(l.modifiers as any[]).map((m) => m.name).join(', ')}</div>
              </div>
              <div className="flex items-center gap-2">
                {!l.sentAt && <Btn tone="ghost" className="min-h-12 px-3" disabled={busy || l.qty <= 1} onClick={() => void setQty(l.id, l.qty - 1)}>-</Btn>}
                <span>{fmt(l.total)}</span>
                {!l.sentAt && <Btn tone="ghost" className="min-h-12 px-3" disabled={busy} onClick={() => void setQty(l.id, l.qty + 1)}>+</Btn>}
                <Btn tone="ghost" className="min-h-12 px-3" disabled={busy} onClick={() => void voidLine(l.id)}>×</Btn>
              </div>
            </div>
          ))}
          {cart.map((l) => (
            <div key={l.uid} className="rounded-xl border border-brand-500 bg-brand-50 p-2">
              <div className="flex items-center justify-between">
                <span className="min-w-0 truncate">{nameOf(l)}{l.variantName ? ` (${l.variantName})` : ''}</span>
                <span>{fmt(l.unitPrice * l.qty)}</span>
              </div>
              <div className="text-xs text-slate-500">{l.modifiers.map((m) => m.name).join(', ')}{l.notes ? ` - ${l.notes}` : ''}</div>
              <div className="mt-1 flex items-center gap-2">
                <Btn tone="ghost" className="min-h-12 px-4" onClick={() => setCart(cart.map((c) => (c.uid === l.uid ? { ...c, qty: Math.max(1, c.qty - 1) } : c)))}>-</Btn>
                <span className="w-8 text-center text-xl">{l.qty}</span>
                <Btn tone="ghost" className="min-h-12 px-4" onClick={() => setCart(cart.map((c) => (c.uid === l.uid ? { ...c, qty: c.qty + 1 } : c)))}>+</Btn>
                <Btn tone="ghost" className="ml-auto min-h-12 px-4" onClick={() => setCart(cart.filter((c) => c.uid !== l.uid))}>×</Btn>
              </div>
            </div>
          ))}
          {!serverLines.length && !cart.length && <p className="py-8 text-center text-slate-400">Tap an item to start</p>}
        </div>
        <div className="my-2 space-y-1 border-t pt-2 text-lg">
          {o && Number(o.discountTotal) > 0 && <div className="flex justify-between text-sm text-emerald-700"><span>{t('Discount')}</span><span>-{fmt(o.discountTotal)}</span></div>}
          <div className="flex justify-between text-2xl font-bold"><span>{t('Total')}</span><span>{fmt(num(o?.total) + cartTotal)}</span></div>
        </div>
        {offline ? (
          <Btn disabled={!cart.length} onClick={() => setDialog('cash')}>{t('Cash')} - {t('Pay')}</Btn>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Btn tone="ghost" disabled={busy} onClick={() => setDialog('customer')}>{t('Customer')}</Btn>
            <Btn tone="ghost" disabled={busy || (!cart.length && !id)} onClick={() => void act(async () => setDialog('discount'))}>{t('Discount')}</Btn>
            <Btn tone="ghost" disabled={busy || !serverLines.length} onClick={() => setDialog('split')}>{t('Split')}</Btn>
            <Btn tone="ghost" disabled={busy || !id} onClick={() => setDialog('table')}>{t('Table')}</Btn>
            <Btn tone="warn" disabled={busy || (!cart.length && !id)} onClick={async () => { setBusy(true); try { await flush(); nav('/orders'); } catch (e) { setError(e); } finally { setBusy(false); } }}>{t('Hold')}</Btn>
            <Btn tone="ghost" disabled={busy || (!cart.length && !serverLines.some((l) => !l.sentAt))} onClick={() => void act((oid) => api(`/pos/orders/${oid}/send`, { method: 'POST', body: {} }))}>{t('Send')}</Btn>
            <Btn className="col-span-2" disabled={busy || (!cart.length && !serverLines.length)} onClick={async () => { setBusy(true); try { const oid = await flush(); nav(`/pay/${oid}`); } catch (e) { setError(e); setBusy(false); } }}>{t('Pay')}</Btn>
          </div>
        )}
      </aside>

      {item && <ItemDialog item={item} onClose={() => setItem(null)} onAdd={(l) => { setCart([...cart, l]); setItem(null); }} />}
      {dialog === 'table' && <TablePicker branchId={branch!.id} cached={offline ? bundle.data?.menu.tables ?? [] : undefined} onClose={() => setDialog(null)} onPick={async (tid, name) => { setDialog(null); if (!id) return setTable({ id: tid, name }); try { await api(`/pos/orders/${id}/table`, { body: { tableId: tid } }); await refresh(); } catch (e) { setError(e); } }} />}
      {dialog === 'customer' && <CustomerPicker onClose={() => setDialog(null)} onPick={async (c) => { setDialog(null); setCustomer(c); if (!id) return; try { await api(`/pos/orders/${id}`, { method: 'PATCH', body: { customerId: c.id } }); await refresh(); } catch (e) { setError(e); } }} />}
      {dialog === 'discount' && id && <DiscountDialog orderId={id} hasCustomer={!!o?.customerId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void refresh(); }} />}
      {dialog === 'split' && o && <SplitDialog order={o} onClose={() => setDialog(null)} onDone={(sid) => { setDialog(null); nav(`/order/${sid}`); }} />}
      {dialog === 'cash' && <CashOfflineDialog total={cartTotal} onClose={() => setDialog(null)} onConfirm={(v) => void sellOffline(v)} />}
    </div>
  );
}
