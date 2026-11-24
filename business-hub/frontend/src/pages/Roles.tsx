import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, Input } from '../components/ui';
import { api } from '../lib/api';

// Which roles reach which modules. Defaults come from the system; the owner can grant or remove access per role.
export default function Roles() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['role-matrix'], queryFn: () => api<any>('/roles/matrix') });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/auth/me') });
  const isOwner = me.data?.roles?.some((r: any) => r.key === 'OWNER');
  const [nr, setNr] = useState({ name: '', rank: '20' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['role-matrix'] });
  const set = useMutation({ mutationFn: (x: { roleKey: string; area: string; allow: boolean | null }) => api('/roles/permissions', { method: 'PUT', body: x }), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['me'] }); } });
  const add = useMutation({ mutationFn: () => api('/roles', { body: { name: nr.name, rank: Number(nr.rank) } }), onSuccess: () => { setNr({ name: '', rank: '20' }); refresh(); qc.invalidateQueries({ queryKey: ['roles'] }); } });
  const del = useMutation({ mutationFn: (key: string) => api(`/roles/${key}`, { method: 'DELETE' }), onSuccess: refresh });
  const m = q.data;
  const ov = (r: string, a: string) => m?.overrides.find((o: any) => o.roleKey === r && o.area === a)?.allow as boolean | undefined;
  const effective = (r: string, area: any) => (r === 'OWNER' ? true : ov(r, area.area) ?? area.defaults.includes(r));
  return (
    <div className="space-y-4">
      <ErrorBox error={q.error ?? set.error ?? add.error ?? del.error} />
      <Card title="What each role can reach">
        <p className="mb-3 text-xs text-slate-500">A tick means members of the role can use that module's screens and actions. Changes are saved at once and logged. Actions reserved for the owner, and the fixed modules (users, organization, approval policies), cannot be granted. Highlighted cells differ from the system default. {!isOwner && 'Only the owner can change this.'}</p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="border-b text-xs text-slate-600"><th className="py-2 pe-3 text-start">Module</th>{m?.roles.map((r: any) => <th key={r.key} className="px-2 text-center font-medium">{r.name}{r.custom && <button className="ms-1 text-red-600" title={r.users ? 'Remove it from its users first' : 'Delete role'} disabled={!isOwner || r.users > 0} onClick={() => window.confirm(`Delete role ${r.name}?`) && del.mutate(r.key)}>×</button>}<div className="text-[10px] font-normal text-slate-400">{r.users} user{r.users === 1 ? '' : 's'}</div></th>)}</tr></thead>
            <tbody>
              {m?.areas.map((a: any) => (
                <tr key={a.area} className="border-b border-slate-100">
                  <td className="py-1.5 pe-3"><div className="font-medium">{a.label}</div><div className="text-xs text-slate-500">{a.hint}</div></td>
                  {m.roles.map((r: any) => {
                    const on = effective(r.key, a), changed = ov(r.key, a.area) !== undefined;
                    return <td key={r.key} className={`px-2 text-center ${changed ? 'bg-amber-50' : ''}`}><input type="checkbox" checked={on} disabled={!isOwner || r.key === 'OWNER' || a.locked || set.isPending} title={a.locked ? 'Fixed' : changed ? 'Changed from the default' : ''} onChange={(e) => set.mutate({ roleKey: r.key, area: a.area, allow: e.target.checked === a.defaults.includes(r.key) ? null : e.target.checked })} /></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {isOwner && (
        <Card title="Add a role">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Name"><Input required minLength={2} value={nr.name} onChange={(e) => setNr({ ...nr, name: e.target.value })} placeholder="e.g. Shift supervisor" /></Field>
            <Field label="Rank (1-99, higher = more authority)"><Input className="w-24" type="number" min="1" max="99" value={nr.rank} onChange={(e) => setNr({ ...nr, rank: e.target.value })} /></Field>
            <Button disabled={add.isPending}>Add role</Button>
          </form>
          <p className="mt-2 text-xs text-slate-500">A new role starts with no access. Tick the modules it needs above, then give it to employees on their file (Employees, Login and role).</p>
        </Card>
      )}
    </div>
  );
}
