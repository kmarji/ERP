import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Btn, Err, Input } from '../components/ui';
import { api } from '../lib/api';
import { fmt, num } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNet } from '../lib/offline';
import { useSession } from '../lib/session';

export default function ShiftPage() {
  const { t } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const qc = useQueryClient();
  const shift = useQuery({ queryKey: ['shift', branch!.id], queryFn: () => api<any>(`/pos/shifts/current?branchId=${branch!.id}`), enabled: net.online });
  const s = shift.data?.id ? shift.data : null;
  const report = useQuery({ queryKey: ['shift-report', s?.id], queryFn: () => api<any>(`/pos/shifts/${s.id}/report`), enabled: !!s });
  const [float, setFloat] = useState('0');
  const [drop, setDrop] = useState('');
  const [counted, setCounted] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['shift'] }); void qc.invalidateQueries({ queryKey: ['shift-report'] }); };
  const open = useMutation({ mutationFn: () => api('/pos/shifts', { body: { branchId: branch!.id, openingFloat: num(float) } }), onSuccess: refresh });
  const dropM = useMutation({ mutationFn: () => api(`/pos/shifts/${s.id}/drops`, { body: { amount: num(drop), reason: 'Safe drop' } }), onSuccess: () => { setDrop(''); refresh(); } });
  const close = useMutation({ mutationFn: () => api<any>(`/pos/shifts/${s.id}/close`, { body: { countedCash: num(counted) } }), onSuccess: refresh });

  if (!net.online) return <p className="p-8 text-xl">Shifts can only be opened or closed while online.</p>;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Err error={open.error ?? dropM.error ?? close.error ?? shift.error} />
      {close.data && (
        <div className="rounded-2xl bg-emerald-50 p-4 text-lg">
          Shift closed. Expected {fmt(close.data.expectedCash)}, counted {fmt(close.data.countedCash)}, variance <b className={num(close.data.variance) === 0 ? '' : 'text-red-600'}>{fmt(close.data.variance)}</b>.
        </div>
      )}
      {!s ? (
        <div className="space-y-3 rounded-2xl bg-white p-4">
          <h2 className="text-xl font-semibold">{t('Open shift')}</h2>
          <Input inputMode="decimal" placeholder={t('Opening float')} value={float} onChange={(e) => setFloat(e.target.value)} />
          <Btn className="w-full" disabled={open.isPending} onClick={() => open.mutate()}>{t('Open shift')}</Btn>
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-white p-4 text-lg">
            <div>Opened {new Date(s.openedAt).toLocaleString('en-GB')}</div>
            {report.data && <>
              <div>{report.data.orders} orders, total {fmt(report.data.total)} JOD</div>
              <div>{report.data.byTender.map((x: any) => `${x.method} ${fmt(x.amount)}`).join(' / ')}</div>
              <div className="font-semibold">Expected cash in drawer: {fmt(report.data.expectedCash)}</div>
            </>}
          </div>
          <div className="flex gap-3 rounded-2xl bg-white p-4">
            <Input inputMode="decimal" placeholder={t('Cash drop')} value={drop} onChange={(e) => setDrop(e.target.value)} />
            <Btn tone="ghost" disabled={!drop || dropM.isPending} onClick={() => dropM.mutate()}>{t('Cash drop')}</Btn>
          </div>
          <div className="flex gap-3 rounded-2xl bg-white p-4">
            <Input inputMode="decimal" placeholder={t('Counted cash')} value={counted} onChange={(e) => setCounted(e.target.value)} />
            <Btn tone="danger" disabled={!counted || close.isPending} onClick={() => close.mutate()}>{t('Close shift')}</Btn>
          </div>
        </>
      )}
    </div>
  );
}
