import { ReactNode } from 'react';

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' | 'warn' };
export function Btn({ tone = 'primary', className = '', ...p }: BtnProps) {
  const c = { primary: 'bg-brand-600 text-white active:bg-brand-700', ghost: 'bg-white border border-slate-300 text-slate-800 active:bg-slate-100', danger: 'bg-red-600 text-white active:bg-red-700', warn: 'bg-amber-500 text-white active:bg-amber-600' }[tone];
  return <button {...p} className={`min-h-14 rounded-xl px-5 text-lg font-medium disabled:opacity-40 ${c} ${className}`} />;
}

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`min-h-14 w-full rounded-xl border border-slate-300 bg-white px-4 text-lg focus:border-brand-500 focus:outline-none ${p.className ?? ''}`} />
);

export function Modal({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className={`max-h-full w-full overflow-auto rounded-2xl bg-white p-5 shadow-xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold">{title}</h2>
          {onClose && <button className="h-12 w-12 rounded-full text-2xl text-slate-500 active:bg-slate-100" onClick={onClose} aria-label="Close">×</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export const Err = ({ error }: { error: unknown }) => (error ? <p className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-red-700">{(error as Error).message}</p> : null);

export function Chip({ on, children, ...p }: { on: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} className={`min-h-12 rounded-full border px-5 text-lg ${on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white'} disabled:opacity-40`}>
      {children}
    </button>
  );
}
