import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, PageHeader, StatusBadge, Table } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

export default function Onboarding() {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const offers = useQuery({ queryKey: ['offers'], queryFn: () => api<any[]>('/offers') });
  const [sel, setSel] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['offers'] });
  const act = useMutation({ mutationFn: (x: { id: string; a: 'send' | 'withdraw' | 'countersign' }) => api(`/offers/${x.id}/${x.a}`, { method: 'POST' }), onSuccess: refresh });
  return (
    <div>
      <PageHeader title="Onboarding" subtitle="Offer, signature, documents and employee creation. The candidate enters personal details once." />
      <ErrorBox error={offers.error ?? act.error} />
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Offers" className="lg:col-span-3">
          {offers.data?.length === 0 ? <Empty>No offers yet.</Empty> : (
            <Table head={['No.', 'Salary', 'Start', 'Status', 'Signed', '']}>
              {offers.data?.map((o) => (
                <tr key={o.id} className={sel?.id === o.id ? 'bg-brand-50' : ''}>
                  <td className="px-3 py-2 font-medium"><button className="underline" onClick={() => setSel(o)}>{o.number}</button></td>
                  <td className="px-3 py-2">{formatJOD(o.salaryBasic, lang)}</td>
                  <td className="px-3 py-2 text-xs">{formatDate(o.startDate)}</td>
                  <td className="px-3 py-2"><StatusBadge status={o.status} /></td>
                  <td className="px-3 py-2 text-xs">{o.candidateSignedAt ? 'candidate' : '-'} / {o.countersignedAt ? 'employer' : '-'}</td>
                  <td className="space-x-1 px-3 py-2 text-end">
                    {o.status === 'APPROVED' && <Button variant="ghost" onClick={() => act.mutate({ id: o.id, a: 'send' })}>Send</Button>}
                    {o.status === 'ACCEPTED' && !o.countersignedAt && <Button variant="ghost" onClick={() => act.mutate({ id: o.id, a: 'countersign' })}>Countersign</Button>}
                    {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(o.status) && <Button variant="ghost" onClick={() => act.mutate({ id: o.id, a: 'withdraw' })}>Withdraw</Button>}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <p className="mt-2 text-xs text-slate-500">The employer countersignature must come from someone other than the person who made the offer.</p>
        </Card>
        <div className="lg:col-span-2">{sel ? <Checklist offer={sel} onDone={refresh} /> : <Card><Empty>Select an offer to see its onboarding checklist.</Empty></Card>}</div>
      </div>
    </div>
  );
}

function Checklist({ offer, onDone }: { offer: any; onDone: () => void }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['docs', offer.applicationId], queryFn: () => api<any[]>(`/applications/${offer.applicationId}/documents`) });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const verify = useMutation({ mutationFn: (x: { type: string; approve: boolean }) => api(`/applications/${offer.applicationId}/documents/${x.type}/verify`, { body: { approve: x.approve, note: notes[x.type] || undefined } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['docs'] }) });
  const complete = useMutation({ mutationFn: () => api(`/applications/${offer.applicationId}/complete-onboarding`, { method: 'POST' }), onSuccess: onDone });
  const allVerified = !!docs.data?.length && docs.data.every((d) => d.status === 'VERIFIED');
  const ready = offer.status === 'ACCEPTED' && !!offer.countersignedAt && allVerified;
  return (
    <Card title={`Checklist: ${offer.number}`}>
      <ErrorBox error={docs.error ?? verify.error ?? complete.error} />
      <ul className="mb-3 space-y-1 text-sm">
        <li>{offer.status === 'ACCEPTED' ? '✔' : '○'} Offer accepted and signed by the candidate</li>
        <li>{offer.countersignedAt ? '✔' : '○'} Employer countersignature</li>
        <li>{allVerified ? '✔' : '○'} All required documents verified</li>
        <li className="text-xs text-slate-500">Personal details (national id, date of birth, address, bank) are entered once by the candidate and stored encrypted; the server rejects completion if they are missing.</li>
      </ul>
      {docs.data?.length === 0 ? <Empty>No documents required yet (they appear once the offer is accepted).</Empty> : (
        <Table head={['Document', 'Status', 'Verify']}>
          {docs.data?.map((d) => (
            <tr key={d.type}>
              <td className="px-3 py-2">{d.type}</td>
              <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
              <td className="px-3 py-2">
                {d.status === 'RECEIVED' && (
                  <div className="flex gap-1">
                    <Input className="w-28" placeholder="Note" value={notes[d.type] ?? ''} onChange={(e) => setNotes({ ...notes, [d.type]: e.target.value })} />
                    <Button onClick={() => verify.mutate({ type: d.type, approve: true })}>OK</Button>
                    <Button variant="danger" onClick={() => verify.mutate({ type: d.type, approve: false })}>Reject</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Button className="mt-3" disabled={!ready || complete.isPending} onClick={() => complete.mutate()}>Complete onboarding</Button>
      {!ready && <p className="mt-1 text-xs text-slate-500">Enabled when the offer is signed by both sides and every document is verified.</p>}
      {complete.data && <p className="mt-2 rounded bg-emerald-50 p-2 text-sm text-emerald-800">Employee created: {(complete.data as any).number ?? (complete.data as any).id ?? 'done'}</p>}
    </Card>
  );
}
