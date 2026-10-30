import { createContext, ReactNode, useContext, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Btn, Err, Input, Modal } from './ui';

export interface ManagerOverride {
  email: string;
  password: string;
}

type Run = <T>(fn: (override?: ManagerOverride) => Promise<T>) => Promise<T>;
const Ctx = createContext<{ run: Run }>({ run: (fn) => fn() });

// Runs an action; if the server answers 403 (needs approval) a manager signs in on this tablet and it is retried
// with their credentials, so the approver is recorded while the cashier's shift stays in use.
export function OverrideProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [ask, setAsk] = useState<{ message: string; error?: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const pending = useRef<{ resolve: (o: ManagerOverride | null) => void } | null>(null);

  const prompt = (message: string, error?: string) =>
    new Promise<ManagerOverride | null>((resolve) => {
      pending.current = { resolve };
      setAsk({ message, error });
    });
  const finish = (o: ManagerOverride | null) => {
    pending.current?.resolve(o);
    pending.current = null;
    setAsk(null);
    setPassword('');
  };

  const run: Run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
      let message = e.message;
      let error: string | undefined;
      for (;;) {
        const o = await prompt(message, error);
        if (!o) throw e;
        try {
          return await fn(o);
        } catch (e2) {
          if (!(e2 instanceof ApiError) || e2.status !== 403) throw e2;
          message = e.message;
          error = e2.message;
        }
      }
    }
  };

  return (
    <Ctx.Provider value={{ run }}>
      {children}
      {ask && (
        <Modal title={t('Manager approval')} onClose={() => finish(null)}>
          <p className="mb-3 text-slate-600">{ask.message}</p>
          <Err error={ask.error ? new Error(ask.error) : null} />
          <div className="space-y-3">
            <Input type="email" placeholder={t('Email')} value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
            <Input type="password" placeholder={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="flex gap-3">
              <Btn tone="ghost" className="flex-1" onClick={() => finish(null)}>{t('Cancel')}</Btn>
              <Btn className="flex-1" disabled={!email || !password} onClick={() => finish({ email, password })}>{t('Manager approval')}</Btn>
            </div>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useOverride = () => useContext(Ctx).run;
