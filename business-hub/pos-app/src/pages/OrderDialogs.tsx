import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Chip, Err, Input, Modal } from '../components/ui';
import { api } from '../lib/api';
import { fmt, num } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useOverride } from '../components/Override';

// `cached` (from the offline bundle) replaces the live list when the tablet is offline; occupancy is unknown then.
export function TablePicker({ branchId, cached, onPick, onClose }: { branchId: string; cached?: { id: string; name: string; seats: number }[]; onPick: (tableId: string, name: string) => void; onClose: () => void }) {
  const nav = useNavigate();
  const live = useQuery({ queryKey: ['tables', branchId], queryFn: () => api<any[]>(`/floor/tables?branchId=${branchId}`), enabled: !cached });
  const tables = cached ? { data: cached.map((t) => ({ ...t, openOrderId: null as string | null, openOrderNumber: null as string | null })), error: null } : live;
  return (
    <Modal title="Table" onClose={onClose} wide>
      <Err error={tables.error} />
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {tables.data?.map((t) => (
          <button key={t.id} onClick={() => (t.openOrderId ? nav(`/order/${t.openOrderId}`) : onPick(t.id, t.name))} className={`min-h-20 rounded-xl border p-2 text-lg ${t.openOrderId ? 'border-amber-400 bg-amber-50' : 'border-slate-300 bg-white'}`}>
            <div className="font-semibold">{t.name}</div>
            <div className="text-xs text-slate-500">{t.openOrderId ? `Open ${t.openOrderNumber}` : `${t.seats} seats`}</div>
          </button>
        ))}
        {tables.data?.length === 0 && <p className="col-span-full text-slate-500">No tables are set up for this branch.</p>}
      </div>
    </Modal>
  );
}

export function CustomerPicker({ onPick, onClose }: { onPick: (c: { id: string; name: string; points: number }) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['customers', q], queryFn: () => api<any[]>(`/customers?q=${encodeURIComponent(q)}`), enabled: q.length >= 2 });
  return (
    <Modal title="Customer" onClose={onClose}>
      <Input autoFocus placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <Err error={list.error} />
      <div className="mt-3 space-y-2">
        {list.data?.map((c) => (
          <button key={c.id} className="flex min-h-14 w-full items-center justify-between rounded-xl border px-4 text-lg active:bg-slate-100" onClick={() => onPick(c)}>
            <span>{c.name} <span className="text-slate-500">{c.phone}</span></span>
            <span className="text-sm text-slate-500">{c.points} pts</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// Percent / amount discounts may need a manager (override dialog); vouchers and loyalty points are validated by the server.
export function DiscountDialog({ orderId, hasCustomer, onDone, onClose }: { orderId: string; hasCustomer: boolean; onDone: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const override = useOverride();
  const [mode, setMode] = useState<'PERCENT' | 'AMOUNT' | 'VOUCHER' | 'POINTS'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const apply = useMutation({
    mutationFn: async () => {
      if (mode === 'VOUCHER') return api(`/pos/orders/${orderId}/voucher`, { body: { code: value.trim() } });
      if (mode === 'POINTS') return api(`/pos/orders/${orderId}/loyalty`, { body: { points: Math.floor(num(value)) } });
      return override((o) => api(`/pos/orders/${orderId}/discount`, { body: { kind: mode, value: num(value), reason: reason || 'Cashier discount', override: o } }));
    },
    onSuccess: onDone,
  });
  const label = { PERCENT: '%', AMOUNT: 'JOD', VOUCHER: 'Code', POINTS: t('Points') }[mode];
  return (
    <Modal title={t('Discount')} onClose={onClose}>
      <div className="mb-4 flex flex-wrap gap-2">
        {(['PERCENT', 'AMOUNT', 'VOUCHER', 'POINTS'] as const).map((m) => <Chip key={m} on={mode === m} disabled={m === 'POINTS' && !hasCustomer} onClick={() => setMode(m)}>{m === 'PERCENT' ? '%' : m === 'AMOUNT' ? 'JOD' : m === 'VOUCHER' ? t('Voucher') : t('Points')}</Chip>)}
      </div>
      {!hasCustomer && <p className="mb-3 text-sm text-slate-500">Loyalty points need a customer attached to the order.</p>}
      <Err error={apply.error} />
      <div className="space-y-3">
        <Input placeholder={label} inputMode={mode === 'VOUCHER' ? 'text' : 'decimal'} value={value} onChange={(e) => setValue(e.target.value)} />
        {(mode === 'PERCENT' || mode === 'AMOUNT') && <Input placeholder={t('Reason')} value={reason} onChange={(e) => setReason(e.target.value)} />}
        <Btn className="w-full" disabled={!value || apply.isPending} onClick={() => apply.mutate()}>{t('Discount')}</Btn>
      </div>
    </Modal>
  );
}

export function SplitDialog({ order, onDone, onClose }: { order: any; onDone: (splitId: string) => void; onClose: () => void }) {
  const lines = order.lines.filter((l: any) => !l.voided);
  const [sel, setSel] = useState<string[]>([]);
  const split = useMutation({ mutationFn: () => api<any>(`/pos/orders/${order.id}/split`, { body: { lineIds: sel } }), onSuccess: (r) => onDone(r.split.id) });
  return (
    <Modal title="Split bill" onClose={onClose}>
      <p className="mb-3 text-slate-600">Pick the items that move to a new bill on the same table.</p>
      <Err error={split.error} />
      <div className="space-y-2">
        {lines.map((l: any) => (
          <Chip key={l.id} on={sel.includes(l.id)} className="w-full text-left" onClick={() => setSel((s) => (s.includes(l.id) ? s.filter((x) => x !== l.id) : [...s, l.id]))}>
            {l.qty} x {l.name} - {fmt(l.total)}
          </Chip>
        ))}
      </div>
      <Btn className="mt-4 w-full" disabled={!sel.length || sel.length >= lines.length || split.isPending} onClick={() => split.mutate()}>Split {sel.length} item(s)</Btn>
    </Modal>
  );
}

export function CashOfflineDialog({ total, onConfirm, onClose }: { total: number; onConfirm: (tendered: number) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [tendered, setTendered] = useState(String(Math.ceil(total)));
  const quick = [...new Set([total, Math.ceil(total), Math.ceil(total / 5) * 5, Math.ceil(total / 10) * 10, Math.ceil(total / 50) * 50])];
  const change = num(tendered) - total;
  return (
    <Modal title={`${t('Cash')} - ${fmt(total)} JOD`} onClose={onClose}>
      <div className="mb-3 flex flex-wrap gap-2">{quick.map((q) => <Chip key={q} on={num(tendered) === q} onClick={() => setTendered(String(q))}>{fmt(q)}</Chip>)}</div>
      <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} />
      <p className="my-3 text-2xl">{t('Change')}: {change >= 0 ? fmt(change) : '-'}</p>
      <Btn className="w-full" disabled={change < 0} onClick={() => onConfirm(num(tendered))}>{t('Complete')}</Btn>
    </Modal>
  );
}
