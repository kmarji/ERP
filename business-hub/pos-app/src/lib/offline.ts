import { useSyncExternalStore } from 'react';
import { api, ApiError, auth, device, deviceHeaders, probe, setNetworkListener } from './api';
import { kvGet, kvSet, outboxAll, outboxDelete, outboxPut, OutboxOp } from './db';

export interface Capabilities {
  supported: string[];
  blocked: { action: string; why: string }[];
}

export interface Bundle {
  version: string;
  branchId: string;
  capabilities: Capabilities;
  menu: { priceVersion: string; generatedAt: string; items: any[]; categories: { id: string; name: string; nameAr?: string | null; sortOrder: number }[]; tables: { id: string; name: string; seats: number }[] };
  fetchedAt: string;
}

export interface Net {
  online: boolean;
  pending: number;
  rejected: number;
  syncing: boolean;
  problem: string | null;
}

let state: Net = { online: navigator.onLine, pending: 0, rejected: 0, syncing: false, problem: null };
const subs = new Set<() => void>();
const set = (patch: Partial<Net>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const useNet = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);

export async function refreshCounts() {
  const ops = await outboxAll();
  set({ pending: ops.filter((o) => o.status === 'PENDING').length, rejected: ops.filter((o) => o.status === 'REJECTED').length });
}

// With a device configured, swap the login token for a 12h session so long offline periods do not expire it.
export async function upgradeSession() {
  if (!device.get()) return;
  try {
    const r = await api<{ accessToken: string }>('/pos/session', { method: 'POST', body: {}, headers: deviceHeaders(), noRedirect: true });
    auth.set(r.accessToken);
  } catch {
    // keep the normal login token; the device may not be enrolled yet
  }
}

export const getBundle = () => kvGet<Bundle>('bundle');

export async function downloadBundle(): Promise<Bundle | null> {
  if (!device.get() || !state.online) return null;
  try {
    const b = await api<Omit<Bundle, 'fetchedAt'>>('/pos/offline/bundle', { headers: deviceHeaders(), noRedirect: true });
    const full = { ...b, fetchedAt: new Date().toISOString() };
    await kvSet('bundle', full);
    set({ problem: null });
    return full;
  } catch (e) {
    if (e instanceof ApiError && e.status) set({ problem: `Offline menu not updated: ${e.message}` });
    return null;
  }
}

export async function queueSale(sale: Record<string, unknown>, meta: { total: number; localNumber: string }) {
  const op: OutboxOp = { opId: crypto.randomUUID(), kind: 'SALE', capturedAt: new Date().toISOString(), status: 'PENDING', localNumber: meta.localNumber, total: meta.total, sale };
  await outboxPut(op);
  await refreshCounts();
  return op;
}

// Uploads PENDING sales in the order they happened. APPLIED and DUPLICATE are done; REJECTED stay visible with the
// server's reason until a manager fixes the cause (the server keeps its own copy and offers a retry).
export async function syncNow() {
  if (state.syncing || !state.online || !device.get()) return;
  const ops = (await outboxAll()).filter((o) => o.status === 'PENDING');
  if (!ops.length) return;
  set({ syncing: true });
  const send = (list: OutboxOp[]) =>
    api<{ results: { opId: string; status: 'APPLIED' | 'DUPLICATE' | 'REJECTED'; code?: string; reason?: string }[] }>('/pos/sync', {
      body: { operations: list.map(({ opId, kind, capturedAt, sale }) => ({ opId, kind, capturedAt, sale })) },
      headers: deviceHeaders(),
      noRedirect: true,
    });
  const apply = async (res: Awaited<ReturnType<typeof send>>, list: OutboxOp[]) => {
    for (const r of res.results) {
      const op = list.find((o) => o.opId === r.opId);
      if (r.status === 'REJECTED' && op) await outboxPut({ ...op, status: 'REJECTED', code: r.code, reason: r.reason });
      else await outboxDelete(r.opId);
    }
  };
  try {
    await apply(await send(ops), ops);
    set({ problem: null });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set({ problem: `Sync blocked: ${e.message}. Sign in again while online.` });
    else if (e instanceof ApiError && e.status) set({ problem: `Sync failed: ${e.message}` });
  } finally {
    set({ syncing: false });
    await refreshCounts();
  }
}

export function startBackground() {
  setNetworkListener((ok) => {
    const online = ok && navigator.onLine;
    const came = online && !state.online;
    set({ online });
    if (came) void syncNow().then(downloadBundle);
  });
  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', () => set({ online: false }));
  void refreshCounts();
  void probe().then(() => { if (state.online) void downloadBundle(); });
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (!state.online) return void probe();
    if (state.pending) void syncNow();
    if (ticks % 20 === 0) void downloadBundle(); // roughly every 5 minutes
  }, 15_000);
}
