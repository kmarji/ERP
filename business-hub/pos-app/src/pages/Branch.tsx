import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Err, Input } from '../components/ui';
import { api, device } from '../lib/api';
import { printReceipt, printer } from '../lib/printer';
import { useI18n } from '../lib/i18n';
import { downloadBundle, getBundle, upgradeSession, useNet } from '../lib/offline';
import { useSession } from '../lib/session';

// Branch selection and device enrollment. A manager enrolls the tablet in the back office (POST /pos/devices)
// and pastes the id + key here; the key is what authorises offline sync.
export default function BranchPage() {
  const nav = useNavigate();
  const { t } = useI18n();
  const { branch, setBranch } = useSession();
  const net = useNet();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<any[]>('/org/branches') });
  const bundle = useQuery({ queryKey: ['bundle'], queryFn: getBundle });
  const [d, setD] = useState(device.get() ?? { id: '', key: '' });
  const [msg, setMsg] = useState('');

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <section>
        <h2 className="mb-3 text-xl font-semibold">{t('Branch')}</h2>
        <Err error={branches.error} />
        <div className="grid grid-cols-2 gap-3">
          {branches.data?.filter((b) => b.active).map((b) => (
            <Btn key={b.id} tone={branch?.id === b.id ? 'primary' : 'ghost'} onClick={() => { setBranch({ id: b.id, name: b.name, code: b.code }); nav('/'); }}>{b.name}</Btn>
          ))}
        </div>
      </section>
      <section className="space-y-3 rounded-2xl bg-white p-4">
        <h2 className="text-xl font-semibold">{t('Device')} (offline sync)</h2>
        <Input placeholder="Device id" value={d.id} onChange={(e) => setD({ ...d, id: e.target.value.trim() })} autoCapitalize="none" />
        <Input placeholder="Device key" value={d.key} onChange={(e) => setD({ ...d, key: e.target.value.trim() })} autoCapitalize="none" />
        <div className="flex gap-3">
          <Btn onClick={async () => { device.set(d); await upgradeSession(); const b = await downloadBundle(); setMsg(b ? `Offline menu downloaded (${b.menu.items.length} items).` : net.online ? 'Saved, but the menu download failed. Check the id and key.' : 'Saved. Connect to download the offline menu.'); void bundle.refetch(); }}>{t('Save')} + download menu</Btn>
          <Btn tone="ghost" onClick={() => { device.clear(); setD({ id: '', key: '' }); setMsg('Device removed.'); }}>Remove</Btn>
        </div>
        <p className="text-slate-600">{msg || (bundle.data ? `Offline menu: ${bundle.data.menu.items.length} items, downloaded ${new Date(bundle.data.fetchedAt).toLocaleString('en-GB')}.` : 'No offline menu downloaded yet.')}</p>
      </section>
      <PrinterSection />
    </div>
  );
}

// Network ESC/POS receipt printer (port 9100). Only the iOS/Android app can open the raw connection; the browser prints via the system dialog.
function PrinterSection() {
  const [p, setP] = useState(printer.get() ?? { ip: '', port: 9100, widthMm: 80 as 58 | 80 });
  const [msg, setMsg] = useState('');
  return (
    <section className="space-y-3 rounded-2xl bg-white p-4">
      <h2 className="text-xl font-semibold">Receipt printer</h2>
      <Input placeholder="Printer IP, e.g. 192.168.1.50" value={p.ip} onChange={(e) => setP({ ...p, ip: e.target.value.trim() })} inputMode="decimal" autoCapitalize="none" />
      <div className="flex gap-3">
        <Input type="number" value={p.port} onChange={(e) => setP({ ...p, port: Number(e.target.value) || 9100 })} />
        <select className="rounded-xl border px-3" value={p.widthMm} onChange={(e) => setP({ ...p, widthMm: Number(e.target.value) as 58 | 80 })}><option value={80}>80 mm</option><option value={58}>58 mm</option></select>
      </div>
      <div className="flex gap-3">
        <Btn onClick={() => { printer.set(p); setMsg('Saved.'); }}>Save</Btn>
        <Btn tone="ghost" onClick={async () => { printer.set(p); try { await printReceipt({ title: 'Business Hub POS' }); setMsg('Test page sent.'); } catch (e: any) { setMsg(`Failed: ${e?.message ?? e}`); } }}>Test print</Btn>
        <Btn tone="ghost" onClick={() => { printer.clear(); setP({ ip: '', port: 9100, widthMm: 80 }); setMsg('Printer removed.'); }}>Remove</Btn>
      </div>
      {msg && <p className="text-slate-600">{msg}</p>}
    </section>
  );
}
