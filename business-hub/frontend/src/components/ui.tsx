import { ReactNode } from 'react';

const TIER: Record<string, string> = {
  LOW: 'bg-slate-100 text-slate-700',
  MEDIUM: 'bg-amber-100 text-amber-800',
  HIGH: 'bg-orange-100 text-orange-800',
  REGULATED: 'bg-red-100 text-red-800',
};

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const cls = tone ? TIER[tone] ?? tone : 'bg-slate-100 text-slate-700';
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export const TierBadge = ({ tier }: { tier: string }) => <Badge tone={tier}>{tier}</Badge>;

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };
export function Button({ variant = 'primary', className = '', ...p }: BtnProps) {
  const v = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700',
    ghost: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return <button {...p} className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${v} ${className}`} />;
}

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={`w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 ${p.className ?? ''}`} />
);

export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm ${p.className ?? ''}`} />
);

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-slate-400">{children}</p>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{(error as Error).message}</p>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-start text-xs uppercase tracking-wide text-slate-500">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: string[]; value: string; onChange: (t: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)} className={`px-4 py-2 text-sm ${value === t ? 'border-b-2 border-brand-600 font-medium text-brand-700' : 'text-slate-500'}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

export const STATUS_TONE: Record<string, string> = {
  POSTED: 'bg-emerald-100 text-emerald-800', PAID: 'bg-emerald-100 text-emerald-800', ISSUED: 'bg-emerald-100 text-emerald-800', CONVERTED: 'bg-emerald-100 text-emerald-800', RECEIVED: 'bg-emerald-100 text-emerald-800', CONFIRMED: 'bg-emerald-100 text-emerald-800', APPLIED: 'bg-emerald-100 text-emerald-800', RECORDED: 'bg-emerald-100 text-emerald-800', UNDER_REVIEW: 'bg-amber-100 text-amber-800',
  EXCEPTION: 'bg-red-100 text-red-800', REJECTED: 'bg-red-100 text-red-800', CANCELLED: 'bg-red-100 text-red-800',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800', PENDING_REVIEW: 'bg-amber-100 text-amber-800', PAYMENT_APPROVED: 'bg-amber-100 text-amber-800', PARTIALLY_RECEIVED: 'bg-amber-100 text-amber-800', OPEN: 'bg-slate-100 text-slate-700',
};
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status]}>{status.replace(/_/g, ' ')}</Badge>;
