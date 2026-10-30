import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Btn, Chip, Err } from '../components/ui';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useNet } from '../lib/offline';
import { useSession } from '../lib/session';

const COLUMNS = [['NEW', 'New'], ['IN_PROGRESS', 'In progress'], ['READY', 'Ready']] as const;

// Kitchen display: polls every 5 seconds; tickets turn amber after 5 minutes and red after 10.
export default function KdsPage() {
  const { t } = useI18n();
  const { branch } = useSession();
  const net = useNet();
  const qc = useQueryClient();
  const [station, setStation] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const stations = useQuery({ queryKey: ['stations', branch!.id], queryFn: () => api<any[]>(`/kds/stations?branchId=${branch!.id}`), enabled: net.online });
  const tickets = useQuery({ queryKey: ['tickets', branch!.id, station], queryFn: () => api<any[]>(`/kds/tickets?branchId=${branch!.id}${station ? `&stationKey=${station}` : ''}`), refetchInterval: 5000, enabled: net.online });
  const act = useMutation({ mutationFn: (v: { id: string; action: string }) => api(`/kds/tickets/${v.id}/${v.action}`, { method: 'POST', body: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) });

  if (!net.online) return <p className="p-8 text-xl">The kitchen display needs a connection.</p>;
  const actions: Record<string, [string, string][]> = { NEW: [['start', 'Start']], IN_PROGRESS: [['ready', 'Ready']], READY: [['bump', 'Bump'], ['recall', 'Recall']] };
  return (
    <div className="flex h-full flex-col gap-3 bg-slate-900 p-3 text-white">
      <div className="flex flex-wrap gap-2">
        <Chip on={station === ''} onClick={() => setStation('')}>All stations</Chip>
        {stations.data?.map((s) => <Chip key={s.id} on={station === s.key} onClick={() => setStation(s.key)}>{s.name}</Chip>)}
      </div>
      <Err error={tickets.error ?? act.error} />
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
        {COLUMNS.map(([status, label]) => (
          <div key={status} className="min-h-0 overflow-auto rounded-2xl bg-slate-800 p-2">
            <div className="mb-2 text-center text-lg font-semibold">{t(label)} ({tickets.data?.filter((x) => x.status === status).length ?? 0})</div>
            <div className="space-y-2">
              {tickets.data?.filter((x) => x.status === status).map((x) => {
                const mins = (Date.now() - new Date(x.createdAt).getTime()) / 60000;
                const tone = mins > 10 ? 'border-red-500' : mins > 5 ? 'border-amber-400' : 'border-slate-600';
                return (
                  <div key={x.id} className={`rounded-xl border-2 bg-slate-700 p-3 ${tone}`}>
                    <div className="flex items-center justify-between text-lg">
                      <b>{x.orderNumber}</b>
                      <span>{x.priority === 'RUSH' && <span className="mr-2 rounded bg-red-600 px-2 py-0.5 text-sm">RUSH</span>}{Math.floor(mins)}m {String(Math.floor((mins % 1) * 60)).padStart(2, '0')}s</span>
                    </div>
                    <div className="text-xs text-slate-300">{x.stationName} - {x.channel}</div>
                    <ul className="my-2 text-lg">
                      {(x.items as any[]).map((i) => (
                        <li key={i.lineId} className={i.cancelled ? 'text-slate-400 line-through' : ''}>
                          {i.qty} x {i.name}
                          {i.modifiers?.length > 0 && <div className="pl-4 text-sm text-slate-300">{i.modifiers.map((m: any) => m.name).join(', ')}</div>}
                          {i.notes && <div className="pl-4 text-sm text-amber-300">{i.notes}</div>}
                        </li>
                      ))}
                    </ul>
                    <div className="flex gap-2">{actions[status].map(([a, l]) => <Btn key={a} tone={a === 'bump' ? 'primary' : 'ghost'} className="flex-1" disabled={act.isPending} onClick={() => act.mutate({ id: x.id, action: a })}>{t(l)}</Btn>)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
