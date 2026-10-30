import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, StatusBadge, Table, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatJOD } from '../lib/format';
import { useI18n } from '../lib/i18n';

const TABS = ['Trial balance', 'Journals', 'Accounts', 'Periods', 'Tax input'];

export default function Finance() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [tab, setTab] = useState(TABS[0]);
  const tb = useQuery({ queryKey: ['tb'], queryFn: () => api<any>('/finance/trial-balance'), enabled: tab === TABS[0] });
  const journals = useQuery({ queryKey: ['journals'], queryFn: () => api<any[]>('/finance/journals'), enabled: tab === TABS[1] });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api<any[]>('/finance/accounts'), enabled: tab === TABS[2] });
  const periods = useQuery({ queryKey: ['periods'], queryFn: () => api<any[]>('/finance/periods'), enabled: tab === TABS[3] });
  const tax = useQuery({ queryKey: ['tax-input'], queryFn: () => api<any>('/tax/input-summary'), enabled: tab === TABS[4] });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [range, setRange] = useState({ startDate: '', endDate: '' });
  const refresh = () => qc.invalidateQueries();
  const reverse = useMutation({ mutationFn: (id: string) => api(`/finance/journals/${id}/reverse`, { body: { reason: reasons[id] } }), onSuccess: refresh });
  const lock = useMutation({ mutationFn: () => api('/finance/periods/lock', { body: range }), onSuccess: refresh });
  const unlock = useMutation({ mutationFn: (id: string) => api(`/finance/periods/${id}/unlock`, { method: 'POST' }), onSuccess: refresh });
  const err = tb.error ?? journals.error ?? accounts.error ?? periods.error ?? tax.error ?? reverse.error ?? lock.error ?? unlock.error;
  const money = (v: string) => formatJOD(v, lang);

  return (
    <div>
      <PageHeader title={t('Finance')} subtitle="The ledger is append-only: corrections are reversing entries, and locked periods reject postings." />
      <ErrorBox error={err} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'Trial balance' && (
        <Card title={<>Trial balance {tb.data && <Badge tone={tb.data.balanced ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}>{tb.data.balanced ? 'balanced' : 'OUT OF BALANCE'}</Badge>}</>}>
          {tb.data?.rows.length === 0 ? <Empty>No postings yet.</Empty> : tb.data && (
            <Table head={['Code', 'Account', 'Debit', 'Credit']}>
              {tb.data.rows.map((r: any) => <tr key={r.code}><td className="px-3 py-2">{r.code}</td><td className="px-3 py-2">{r.name}</td><td className="px-3 py-2">{money(r.debit)}</td><td className="px-3 py-2">{money(r.credit)}</td></tr>)}
              <tr className="font-semibold"><td className="px-3 py-2" colSpan={2}>Total</td><td className="px-3 py-2">{money(tb.data.totalDebit)}</td><td className="px-3 py-2">{money(tb.data.totalCredit)}</td></tr>
            </Table>
          )}
        </Card>
      )}
      {tab === 'Journals' && (
        <div className="space-y-4">
          {journals.data?.length === 0 && <Card><Empty>No journals yet.</Empty></Card>}
          {journals.data?.map((j) => (
            <Card key={j.id}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div><b>{j.number}</b> <span className="text-xs text-slate-500">{formatDate(j.postingDate)} - {j.sourceType} - {j.memo}</span> {j.reversalOfId && <Badge tone="bg-amber-100 text-amber-800">reversal</Badge>}</div>
                {!j.reversalOfId && (
                  <div className="flex gap-1"><Input className="w-44" placeholder="Reason to reverse" value={reasons[j.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [j.id]: e.target.value })} /><Button variant="ghost" disabled={(reasons[j.id] ?? '').length < 3} onClick={() => reverse.mutate(j.id)}>Reverse</Button></div>
                )}
              </div>
              <Table head={['Account', 'Debit', 'Credit']}>{j.lines.map((l: any) => <tr key={l.id}><td className="px-3 py-1">{l.account.code} {l.account.name}</td><td className="px-3 py-1">{Number(l.debit) ? money(l.debit) : ''}</td><td className="px-3 py-1">{Number(l.credit) ? money(l.credit) : ''}</td></tr>)}</Table>
            </Card>
          ))}
        </div>
      )}
      {tab === 'Accounts' && (
        <Card>
          <Table head={['Code', 'Name', 'Type', 'System key']}>
            {accounts.data?.map((a) => <tr key={a.id}><td className="px-3 py-2 font-medium">{a.code}</td><td className="px-3 py-2">{a.name}</td><td className="px-3 py-2">{a.type}</td><td className="px-3 py-2 font-mono text-xs">{a.systemKey ?? '-'}</td></tr>)}
          </Table>
          <p className="mt-3 text-xs text-slate-400">Default chart of accounts is a placeholder: the accountant must review it before go-live.</p>
        </Card>
      )}
      {tab === 'Periods' && (
        <div className="space-y-6">
          <Card title="Lock a period">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); lock.mutate(); }}>
              <Field label="From"><Input type="date" value={range.startDate} onChange={(e) => setRange({ ...range, startDate: e.target.value })} required /></Field>
              <Field label="To"><Input type="date" value={range.endDate} onChange={(e) => setRange({ ...range, endDate: e.target.value })} required /></Field>
              <Button type="submit">Lock</Button>
            </form>
          </Card>
          <Card>
            {periods.data?.length === 0 ? <Empty>No periods locked.</Empty> : (
              <Table head={['From', 'To', 'Status', '']}>
                {periods.data?.map((p) => <tr key={p.id}><td className="px-3 py-2">{formatDate(p.startDate)}</td><td className="px-3 py-2">{formatDate(p.endDate)}</td><td className="px-3 py-2"><StatusBadge status={p.status === 'LOCKED' ? 'REJECTED' : 'OPEN'} /> <span className="text-xs">{p.status}</span></td><td className="px-3 py-2 text-end">{p.status === 'LOCKED' && <Button variant="ghost" onClick={() => unlock.mutate(p.id)}>Unlock (owner)</Button>}</td></tr>)}
              </Table>
            )}
          </Card>
        </div>
      )}
      {tab === 'Tax input' && (
        <Card title="Input tax from posted supplier invoices">
          {tax.data && (
            <>
              <div className="mb-4 flex gap-8 text-sm"><div>Recoverable: <b>{money(tax.data.recoverableInputTax)}</b></div><div>Non-recoverable: <b>{money(tax.data.nonRecoverableInputTax)}</b></div></div>
              {tax.data.lines.length === 0 ? <Empty>No tax evidence yet.</Empty> : (
                <Table head={['Rate', 'Recoverable', 'Base', 'Tax', 'Documents']}>
                  {tax.data.lines.map((l: any, i: number) => <tr key={i}><td className="px-3 py-2">{Number(l.taxRate) * 100}%</td><td className="px-3 py-2">{l.eligible ? 'yes' : 'no'}</td><td className="px-3 py-2">{money(l.base)}</td><td className="px-3 py-2">{money(l.tax)}</td><td className="px-3 py-2">{l.documents}</td></tr>)}
                </Table>
              )}
            </>
          )}
          <p className="mt-3 text-xs text-slate-400">Tax rates are placeholders pending legal verification; the filing workflow builds on these rows.</p>
        </Card>
      )}
    </div>
  );
}
