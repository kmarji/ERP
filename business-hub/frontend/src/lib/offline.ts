import { api, ApiError, upload } from './api';

// W17: checklists completed without a connection wait in this device's storage and sync when it is back.
// The server keeps the first submission per checklist, so a retry or a second device can never double-submit.
const QUEUE = 'bh_offline_queue';
const CACHE = 'bh_offline_cache';

export interface Photo { itemId: string; dataUrl: string; name: string }
export interface Queued {
  runId: string;
  name: string;
  answers: { itemId: string; ok: boolean; note?: string; docId?: string }[];
  photos: Photo[];
  completedAt: string;
  error?: string; // set when the server refused it; needs a person
  note?: string; // set when it synced but the server already had a submission
}

const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } };

export const isNetworkError = (e: unknown) => !(e instanceof ApiError);

export const cache = {
  set: (k: string, v: unknown) => { const c = read<Record<string, unknown>>(CACHE, {}); c[k] = v; write(CACHE, c); },
  get: <T,>(k: string): T | undefined => read<Record<string, T>>(CACHE, {})[k],
};

export const queue = {
  list: () => read<Queued[]>(QUEUE, []),
  // False when the device storage is full (photos are large): the caller must tell the user.
  add: (q: Queued) => write(QUEUE, [...queue.list().filter((x) => x.runId !== q.runId), q]),
  remove: (runId: string) => write(QUEUE, queue.list().filter((x) => x.runId !== runId)),
  patch: (runId: string, p: Partial<Queued>) => write(QUEUE, queue.list().map((x) => (x.runId === runId ? { ...x, ...p } : x))),
};

// GET that falls back to the last copy this device saw when the network is down.
export async function cachedGet<T>(path: string): Promise<T> {
  try {
    const r = await api<T>(path);
    cache.set(path, r);
    return r;
  } catch (e) {
    const c = cache.get<T>(path);
    if (c !== undefined && isNetworkError(e)) return c;
    throw e;
  }
}

let flushing = false;
export async function flush(): Promise<{ synced: number; already: number; failed: number }> {
  const out = { synced: 0, already: 0, failed: 0 };
  if (flushing) return out;
  flushing = true;
  try {
    for (const item of queue.list().filter((x) => !x.error)) {
      try {
        const answers = [...item.answers];
        for (const p of item.photos) {
          const file = new File([await (await fetch(p.dataUrl)).blob()], p.name, { type: 'image/jpeg' });
          const doc = await upload('/documents', file);
          answers.find((a) => a.itemId === p.itemId)!.docId = doc.id;
          queue.patch(item.runId, { answers, photos: item.photos.filter((x) => x !== p) }); // never upload the same photo twice
        }
        const res = await api<any>(`/me/checklists/${item.runId}/submit`, { body: { answers, completedAt: item.completedAt } });
        if (res.alreadySubmitted) { out.already++; queue.patch(item.runId, { note: 'Already submitted earlier: the first submission was kept.' }); } else { out.synced++; queue.remove(item.runId); }
      } catch (e) {
        if (isNetworkError(e)) break; // still offline: try again later, in order
        queue.patch(item.runId, { error: (e as Error).message });
        out.failed++;
      }
    }
  } finally {
    flushing = false;
  }
  return out;
}
