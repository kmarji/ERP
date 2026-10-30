import { uuid } from '../lib/uuid';
import { useState } from 'react';
import { fmt } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { MenuItem } from '../lib/menu';
import { Btn, Chip, Modal } from './ui';

export interface CartLine {
  uid: string;
  menuItemId: string;
  name: string;
  nameAr?: string | null;
  variantId?: string;
  variantName?: string;
  modifiers: { id: string; name: string; priceDelta: number }[];
  qty: number;
  unitPrice: number; // what the customer is shown, tax-inclusive
  taxRate: number;
  notes?: string;
}

// Variant + modifier picker. Add stays disabled until every group's minimum is met.
export function ItemDialog({ item, onAdd, onClose }: { item: MenuItem; onAdd: (l: CartLine) => void; onClose: () => void }) {
  const { t, nameOf } = useI18n();
  const [variantId, setVariantId] = useState<string | undefined>();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const variant = item.variants.find((v) => v.id === variantId);
  const mods = item.groups.flatMap((g) => g.modifiers.filter((m) => picked[g.id]?.includes(m.id)));
  const unit = item.price + (variant?.priceDelta ?? 0) + mods.reduce((s, m) => s + m.priceDelta, 0);
  const valid = item.groups.every((g) => (picked[g.id]?.length ?? 0) >= g.minSelect);

  const toggle = (gid: string, mid: string, max: number) =>
    setPicked((p) => {
      const cur = p[gid] ?? [];
      if (cur.includes(mid)) return { ...p, [gid]: cur.filter((x) => x !== mid) };
      return { ...p, [gid]: max === 1 ? [mid] : cur.length >= max ? cur : [...cur, mid] };
    });

  return (
    <Modal title={nameOf(item)} onClose={onClose}>
      {item.variants.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-sm text-slate-500">Size / variant</div>
          <div className="flex flex-wrap gap-2">
            <Chip on={!variantId} onClick={() => setVariantId(undefined)}>Regular</Chip>
            {item.variants.map((v) => <Chip key={v.id} on={variantId === v.id} onClick={() => setVariantId(v.id)}>{nameOf(v as any)} {v.priceDelta ? `(+${fmt(v.priceDelta)})` : ''}</Chip>)}
          </div>
        </div>
      )}
      {item.groups.map((g) => (
        <div key={g.id} className="mb-4">
          <div className="mb-2 text-sm text-slate-500">{g.name} ({g.minSelect ? `choose ${g.minSelect}-${g.maxSelect}` : `up to ${g.maxSelect}`})</div>
          <div className="flex flex-wrap gap-2">
            {g.modifiers.map((m) => <Chip key={m.id} on={!!picked[g.id]?.includes(m.id)} onClick={() => toggle(g.id, m.id, g.maxSelect)}>{m.name} {m.priceDelta ? `+${fmt(m.priceDelta)}` : ''}</Chip>)}
          </div>
        </div>
      ))}
      <input className="mb-4 min-h-14 w-full rounded-xl border border-slate-300 px-4 text-lg" placeholder={t('Notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <div className="flex items-center gap-3">
        <Btn tone="ghost" onClick={() => setQty(Math.max(1, qty - 1))}>-</Btn>
        <span className="w-10 text-center text-2xl">{qty}</span>
        <Btn tone="ghost" onClick={() => setQty(qty + 1)}>+</Btn>
        <Btn className="flex-1" disabled={!valid} onClick={() => onAdd({ uid: uuid(), menuItemId: item.id, name: item.name, nameAr: item.nameAr, variantId, variantName: variant?.name, modifiers: mods, qty, unitPrice: unit, taxRate: item.taxRate, notes: notes || undefined })}>
          {t('Add')} - {fmt(unit * qty)}
        </Btn>
      </div>
    </Modal>
  );
}
