import { useState } from 'react';
import { ApiError, auth, download, upload } from '../lib/api';
import { Button, ErrorBox } from './ui';

export interface Attachment { id: string; filename: string; mimeType: string; sizeBytes: number }
const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
// Only passive types open inline. SVG, HTML and XML can run script on this origin, so they always download.
const SAFE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg'];
const viewable = (m: string) => SAFE.includes(m);
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// Files open in a new tab when the browser can show them (PDF, images, video, audio); anything else downloads.
async function open(a: Attachment) {
  if (!viewable(a.mimeType)) return download(`/documents/${a.id}/download`, a.filename);
  const res = await fetch(`${BASE}/documents/${a.id}/download`, { headers: { Authorization: `Bearer ${auth.get()}` } });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  // Rebuilt with the vetted type, never the one the server sent.
  window.open(URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: a.mimeType })), '_blank', 'noopener');
}

export function AttachmentList({ items, empty }: { items?: Attachment[]; empty?: string }) {
  const [err, setErr] = useState<unknown>(null);
  if (!items?.length) return empty ? <p className="text-xs text-slate-500">{empty}</p> : null;
  return (
    <div>
      <ErrorBox error={err} />
      <ul className="space-y-1 text-sm">
        {items.map((a) => (
          <li key={a.id} className="flex items-center gap-2">
            <span className="font-medium">{a.filename}</span><span className="text-xs text-slate-500">{size(a.sizeBytes)}</span>
            <Button type="button" variant="ghost" onClick={() => open(a).catch(setErr)}>{viewable(a.mimeType) ? 'Open' : 'Download'}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Managers add any file type (PDF, Word, PowerPoint, Excel, images, video). The server caps a file at 15 MB.
export function AttachPicker({ value, onChange }: { value: Attachment[]; onChange: (v: Attachment[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setErr(null);
    try {
      const added: Attachment[] = [];
      for (const f of Array.from(files)) { const d = await upload('/documents', f); added.push({ id: d.id, filename: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes }); }
      onChange([...value, ...added.filter((a) => !value.some((v) => v.id === a.id))]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1">
      <ErrorBox error={err} />
      {value.map((a) => <div key={a.id} className="flex items-center gap-2 text-sm"><span>{a.filename}</span><span className="text-xs text-slate-500">{size(a.sizeBytes)}</span><Button type="button" variant="ghost" onClick={() => onChange(value.filter((v) => v.id !== a.id))}>Remove</Button></div>)}
      <input type="file" multiple disabled={busy} onChange={(e) => { add(e.target.files); e.target.value = ''; }} className="text-xs" />
      <p className="text-xs text-slate-500">{busy ? 'Uploading...' : 'Any format: PDF, Word, PowerPoint, Excel, images, video. Up to 15 MB each.'}</p>
    </div>
  );
}
