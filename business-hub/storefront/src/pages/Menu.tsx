import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CartLine, useCart, useFetch, useI18n, useTenant } from '../lib';
import type { BranchInfo } from './Branches';

interface Modifier { id: string; name: string; priceDelta: string }
interface Group { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Modifier[] }
interface Variant { id: string; name: string; nameAr: string | null; priceDelta: string }
interface Item { id: string; name: string; nameAr: string | null; categoryId: string | null; price: string; variants: Variant[]; modifierGroups: Group[] }
interface MenuData { categories: { id: string; name: string; nameAr: string | null }[]; items: Item[] }

export default function Menu() {
  const tenant = useTenant();
  const { branchId = '' } = useParams();
  const nav = useNavigate();
  const { t, pick, money } = useI18n();
  const menu = useFetch<MenuData>(`/store/${tenant}/branches/${branchId}/menu`);
  const branches = useFetch<BranchInfo[]>(`/store/${tenant}/branches`);
  const branch = branches.data?.find((b) => b.branchId === branchId);
  const cart = useCart(tenant, branchId);
  const [cat, setCat] = useState<string>('all');
  const [item, setItem] = useState<Item | null>(null);
  const [open, setOpen] = useState(false);
  const min = Number(branch?.minOrder ?? 0);
  const items = menu.data?.items.filter((i) => cat === 'all' || i.categoryId === cat) ?? [];

  return (
    <section>
      <Link to={`/${tenant}`} className="text-sm text-brand-700 underline">← {t('Back')}</Link>
      <h1 className="mb-3 mt-1 text-xl font-semibold">{branch?.name}</h1>
      {menu.error && <p role="alert" className="rounded bg-red-50 p-3 text-red-800">{menu.error.message}</p>}
      {branch && !branch.acceptingOrders && <p role="status" className="mb-3 rounded bg-amber-100 p-3 text-amber-900">{t('Not accepting orders right now')}</p>}

      <div role="tablist" className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ id: 'all', name: t('All'), nameAr: null }, ...(menu.data?.categories ?? [])].map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)} className={`whitespace-nowrap rounded-full border px-4 py-1.5 text-sm ${cat === c.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white'}`}>
            {pick(c.name, c.nameAr)}
          </button>
        ))}
      </div>

      <ul className="grid gap-3">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <h2 className="font-medium">{pick(i.name, i.nameAr)}</h2>
              <p className="text-sm text-slate-700">{money(i.price)}</p>
            </div>
            <button disabled={!branch?.acceptingOrders} onClick={() => setItem(i)} className="shrink-0 rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-400" aria-label={`${t('Add')} ${pick(i.name, i.nameAr)}`}>
              {t('Add')}
            </button>
          </li>
        ))}
      </ul>

      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white p-3">
          <button onClick={() => setOpen(true)} className="mx-auto flex w-full max-w-2xl items-center justify-between rounded-xl bg-brand-700 px-4 py-3 font-medium text-white">
            <span>{t('View cart')} ({cart.count})</span>
            <span>{money(cart.subtotal)}</span>
          </button>
        </div>
      )}

      {item && <ItemSheet item={item} onClose={() => setItem(null)} onAdd={(l) => { cart.add(l); setItem(null); }} />}

      {open && (
        <Dialog title={t('Cart')} onClose={() => setOpen(false)}>
          {cart.lines.length === 0 && <p>{t('Your cart is empty')}</p>}
          <ul className="divide-y">
            {cart.lines.map((l) => (
              <li key={l.key} className="flex items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{pick(l.name, l.nameAr)}</p>
                  <p className="text-xs text-slate-600">{[l.variantName, ...l.modifierNames].filter(Boolean).join(', ')}</p>
                  <p className="text-sm">{money(l.unitPrice * l.qty)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button className="h-9 w-9 rounded-full border text-lg" aria-label="−" onClick={() => cart.setQty(l.key, l.qty - 1)}>−</button>
                  <span aria-live="polite" className="w-6 text-center">{l.qty}</span>
                  <button className="h-9 w-9 rounded-full border text-lg" aria-label="+" onClick={() => cart.setQty(l.key, l.qty + 1)}>+</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between font-semibold"><span>{t('Subtotal')}</span><span>{money(cart.subtotal)}</span></div>
          {cart.subtotal < min && cart.lines.length > 0 && <p role="alert" className="mt-2 rounded bg-amber-100 p-2 text-sm text-amber-900">{t('Minimum order')}: {money(min)}</p>}
          <button disabled={cart.lines.length === 0 || cart.subtotal < min} onClick={() => nav(`/${tenant}/b/${branchId}/checkout`)} className="mt-4 w-full rounded-xl bg-brand-700 py-3 font-medium text-white disabled:bg-slate-400">{t('Checkout')}</button>
        </Dialog>
      )}
    </section>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded px-2 py-1 text-sm underline">{t('Close')}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ItemSheet({ item, onClose, onAdd }: { item: Item; onClose: () => void; onAdd: (l: Omit<CartLine, 'key'>) => void }) {
  const { t, pick, money } = useI18n();
  const [variantId, setVariantId] = useState<string | undefined>();
  const [mods, setMods] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const variant = item.variants.find((v) => v.id === variantId);
  const picked = item.modifierGroups.flatMap((g) => g.modifiers.filter((m) => mods[g.id]?.includes(m.id)));
  const unit = Number(item.price) + Number(variant?.priceDelta ?? 0) + picked.reduce((s, m) => s + Number(m.priceDelta), 0);
  const valid = item.modifierGroups.every((g) => (mods[g.id]?.length ?? 0) >= g.minSelect && (mods[g.id]?.length ?? 0) <= g.maxSelect);

  const toggle = (g: Group, id: string) =>
    setMods((cur) => {
      const have = cur[g.id] ?? [];
      if (g.maxSelect === 1) return { ...cur, [g.id]: [id] };
      if (have.includes(id)) return { ...cur, [g.id]: have.filter((x) => x !== id) };
      return have.length >= g.maxSelect ? cur : { ...cur, [g.id]: [...have, id] };
    });

  return (
    <Dialog title={pick(item.name, item.nameAr)} onClose={onClose}>
      {item.variants.length > 0 && (
        <fieldset className="mb-4">
          <legend className="mb-1 font-medium">{t('Select')}</legend>
          {[{ id: undefined as string | undefined, name: 'Regular', nameAr: null as string | null, priceDelta: '0' }, ...item.variants].map((v) => (
            <label key={v.id ?? 'base'} className="flex items-center justify-between py-1.5">
              <span><input type="radio" name="variant" className="me-2" checked={variantId === v.id} onChange={() => setVariantId(v.id)} />{pick(v.name, v.nameAr)}</span>
              {Number(v.priceDelta) !== 0 && <span className="text-sm text-slate-600">+{money(v.priceDelta)}</span>}
            </label>
          ))}
        </fieldset>
      )}
      {item.modifierGroups.map((g) => (
        <fieldset key={g.id} className="mb-4">
          <legend className="mb-1 font-medium">{g.name}{g.minSelect > 0 && <span className="ms-2 text-xs text-red-700">{t('Required')} ({g.minSelect})</span>}</legend>
          {g.modifiers.map((m) => {
            const on = mods[g.id]?.includes(m.id) ?? false;
            return (
              <label key={m.id} className="flex items-center justify-between py-1.5">
                <span>
                  <input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} className="me-2" checked={on} disabled={!on && g.maxSelect > 1 && (mods[g.id]?.length ?? 0) >= g.maxSelect} onChange={() => toggle(g, m.id)} />
                  {m.name}
                </span>
                {Number(m.priceDelta) !== 0 && <span className="text-sm text-slate-600">+{money(m.priceDelta)}</span>}
              </label>
            );
          })}
        </fieldset>
      ))}
      <div className="mb-3 flex items-center gap-3">
        <button className="h-10 w-10 rounded-full border text-lg" aria-label="−" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
        <span aria-live="polite" className="w-8 text-center text-lg">{qty}</span>
        <button className="h-10 w-10 rounded-full border text-lg" aria-label="+" onClick={() => setQty(Math.min(50, qty + 1))}>+</button>
      </div>
      <button
        disabled={!valid}
        onClick={() => onAdd({ menuItemId: item.id, name: item.name, nameAr: item.nameAr, variantId, variantName: variant?.name, modifierIds: picked.map((m) => m.id), modifierNames: picked.map((m) => m.name), unitPrice: unit, qty })}
        className="w-full rounded-xl bg-brand-700 py-3 font-medium text-white disabled:bg-slate-400"
      >
        {t('Add to cart')} · {money(unit * qty)}
      </button>
    </Dialog>
  );
}
