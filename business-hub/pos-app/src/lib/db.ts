// Plain IndexedDB (kv + outbox). Falls back to localStorage where IndexedDB is unavailable (e.g. some private modes).
const NAME = 'pos-app';
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('outbox', { keyPath: 'opId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}

function run<T>(store: 'kv' | 'outbox', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const req = fn(db!.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

const ls = {
  get: <T>(k: string, fallback: T): T => {
    try {
      return JSON.parse(localStorage.getItem(`pos.db.${k}`) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (k: string, v: unknown) => localStorage.setItem(`pos.db.${k}`, JSON.stringify(v)),
};

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await open()) ? ((await run<T>('kv', 'readonly', (s) => s.get(key))) as T | undefined) : ls.get<T | undefined>(`kv.${key}`, undefined);
}

export async function kvSet(key: string, value: unknown) {
  if (await open()) await run('kv', 'readwrite', (s) => s.put(value, key));
  else ls.set(`kv.${key}`, value);
}

export interface OutboxOp {
  opId: string;
  kind: 'SALE';
  capturedAt: string;
  status: 'PENDING' | 'REJECTED';
  localNumber: string;
  total: number;
  sale: Record<string, unknown>;
  code?: string;
  reason?: string;
}

export async function outboxAll(): Promise<OutboxOp[]> {
  const rows = (await open()) ? (((await run<OutboxOp[]>('outbox', 'readonly', (s) => s.getAll())) as OutboxOp[]) ?? []) : ls.get<OutboxOp[]>('outbox', []);
  return rows.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export async function outboxPut(op: OutboxOp) {
  if (await open()) await run('outbox', 'readwrite', (s) => s.put(op));
  else ls.set('outbox', [...(await outboxAll()).filter((o) => o.opId !== op.opId), op]);
}

export async function outboxDelete(opId: string) {
  if (await open()) await run('outbox', 'readwrite', (s) => s.delete(opId));
  else ls.set('outbox', (await outboxAll()).filter((o) => o.opId !== opId));
}
