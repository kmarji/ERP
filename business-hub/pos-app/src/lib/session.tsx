import { createContext, ReactNode, useContext, useState } from 'react';

export interface Branch {
  id: string;
  name: string;
  code: string;
}

const KEY = 'pos.branch';
const Ctx = createContext<{ branch: Branch | null; setBranch: (b: Branch | null) => void }>({ branch: null, setBranch: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [branch, set] = useState<Branch | null>(() => JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  const setBranch = (b: Branch | null) => {
    if (b) localStorage.setItem(KEY, JSON.stringify(b));
    else localStorage.removeItem(KEY);
    set(b);
  };
  return <Ctx.Provider value={{ branch, setBranch }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
