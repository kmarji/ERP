export const BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const TOKEN = 'pos.token';
const DEVICE = 'pos.device';

export const auth = {
  token: () => localStorage.getItem(TOKEN),
  set: (t: string) => localStorage.setItem(TOKEN, t),
  clear: () => localStorage.removeItem(TOKEN),
};

export interface Device {
  id: string;
  key: string;
}

export const device = {
  get: (): Device | null => {
    try {
      return JSON.parse(localStorage.getItem(DEVICE) ?? 'null');
    } catch {
      return null;
    }
  },
  set: (d: Device) => localStorage.setItem(DEVICE, JSON.stringify(d)),
  clear: () => localStorage.removeItem(DEVICE),
};

export const deviceHeaders = (): Record<string, string> => {
  const d = device.get();
  return d ? { 'x-device-id': d.id, 'x-device-key': d.key } : {};
};

// Connectivity is learned from real requests: a thrown fetch means unreachable, any HTTP answer means reachable.
let onNetwork: (ok: boolean) => void = () => {};
export const setNetworkListener = (fn: (ok: boolean) => void) => (onNetwork = fn);

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; noRedirect?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers };
  const token = auth.token();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ? JSON.stringify(init.body) : undefined });
  } catch {
    onNetwork(false);
    throw new ApiError(0, 'Server unreachable');
  }
  onNetwork(true);
  if (res.status === 401 && token && !init.noRedirect) {
    auth.clear();
    window.location.assign('/login');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? res.statusText);
  return data as T;
}

export async function probe(): Promise<boolean> {
  try {
    await fetch(`${BASE}/docs`, { method: 'HEAD', cache: 'no-store' });
    onNetwork(true);
    return true;
  } catch {
    onNetwork(false);
    return false;
  }
}

export const newKey = () => crypto.randomUUID();
