import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, Select, Table } from '../components/ui';
import { api, download, upload } from '../lib/api';

export const TEMPLATE_TYPES: Record<string, string> = { '': 'Both', OPEN: 'Open-ended', FIXED_TERM: 'Fixed term' };
export const useTemplates = () => useQuery({ queryKey: ['contract-templates'], queryFn: () => api<any[]>('/contract-templates') });

const MARKERS: [string, string][] = [
  ['employee_name', 'Candidate name'], ['employee_name_ar', 'Arabic name (blank if not recorded)'], ['nationality', 'Nationality (blank if not recorded)'],
  ['job_title', 'Job title'], ['job_title_ar', 'Arabic job title'], ['branch', 'Branch'], ['employer_name', 'Company'], ['tax_number', 'Company tax number'],
  ['start_date', 'Start date'], ['end_date', 'End date (fixed term)'], ['contract_type', 'Open-ended / Fixed term'], ['basic_salary', 'Basic salary'],
  ['allowances', 'Allowances list'], ['total_salary', 'Basic plus allowances'], ['probation_months', 'Probation months'], ['weekly_hours', 'Weekly hours'],
  ['offer_number', 'Offer number'], ['today', 'Date the offer was made'],
];

export default function ContractTemplates() {
  const qc = useQueryClient();
  const list = useTemplates();
  const [f, setF] = useState({ name: '', contractType: '' });
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['contract-templates'] });
  const add = useMutation({ mutationFn: () => upload('/contract-templates', file!, f), onSuccess: () => { setF({ name: '', contractType: '' }); setFile(null); if (picker.current) picker.current.value = ''; refresh(); } });
  const change = useMutation({ mutationFn: (x: { id: string; body: object }) => api(`/contract-templates/${x.id}`, { method: 'PATCH', body: x.body }), onSuccess: refresh });
  const replace = useMutation({ mutationFn: (x: { id: string; file: File }) => upload(`/contract-templates/${x.id}/file`, x.file, {}, 'PUT'), onSuccess: refresh });
  const get = useMutation({ mutationFn: (t: any) => download(`/contract-templates/${t.id}/download`, t.filename) });
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card title="Templates" className="lg:col-span-3">
        <ErrorBox error={list.error ?? change.error ?? replace.error ?? get.error} />
        {list.data?.length === 0 ? <Empty>No templates yet. Offers use the built-in contract text.</Empty> : (
          <Table head={['Name', 'For', 'File', 'Active', '']}>
            {list.data?.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2 font-medium">{t.name}</td>
                <td className="px-3 py-2"><Select aria-label={`Contract type for ${t.name}`} value={t.contractType ?? ''} onChange={(e) => change.mutate({ id: t.id, body: { contractType: e.target.value } })}>{Object.entries(TEMPLATE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></td>
                <td className="px-3 py-2"><button className="underline" onClick={() => get.mutate(t)}>{t.filename}</button></td>
                <td className="px-3 py-2">{t.active ? 'Yes' : 'No'}</td>
                <td className="space-x-1 px-3 py-2 text-end">
                  <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium">Replace file
                    <input type="file" accept=".docx" className="sr-only" onChange={(e) => { const chosen = e.target.files?.[0]; if (chosen) replace.mutate({ id: t.id, file: chosen }); e.target.value = ''; }} />
                  </label>
                  <Button variant="ghost" onClick={() => change.mutate({ id: t.id, body: { active: !t.active } })}>{t.active ? 'Deactivate' : 'Activate'}</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="space-y-6 lg:col-span-2">
        <Card title="Upload a template">
          <ErrorBox error={add.error} />
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Name"><Input required minLength={2} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Used for"><Select value={f.contractType} onChange={(e) => setF({ ...f, contractType: e.target.value })}>{Object.entries(TEMPLATE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Word file (.docx, up to 5 MB)"><input ref={picker} type="file" accept=".docx" required className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Button disabled={!file || add.isPending}>{add.isPending ? 'Uploading...' : 'Upload'}</Button>
          </form>
        </Card>
        <Card title="Markers you can type in the document">
          <ul className="space-y-1 text-sm">{MARKERS.map(([m, what]) => <li key={m}><code className="select-all rounded bg-slate-100 px-1">{`{{${m}}}`}</code> <span className="text-slate-500">{what}</span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
