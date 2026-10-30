import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, ErrorBox, Field, Input } from '../components/ui';
import { api, auth } from '../lib/api';
import { useI18n } from '../lib/i18n';

export default function Login() {
  const nav = useNavigate();
  const { t } = useI18n();
  const [tenant, setTenant] = useState('demo');
  const [email, setEmail] = useState('owner@demo.test');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<{ accessToken: string }>('/auth/login', { body: { tenant, email, password } }),
    onSuccess: (r) => {
      auth.set(r.accessToken);
      localStorage.setItem('bh_tenant', tenant);
      nav('/');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 p-6">
      <Card className="w-full max-w-sm">
        <h1 className="mb-1 text-xl font-semibold text-brand-900">Business Hub</h1>
        <p className="mb-5 text-sm text-slate-500">{t('Sign in')}</p>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBox error={login.error} />
          <Field label="Business"><Input value={tenant} onChange={(e) => setTenant(e.target.value)} /></Field>
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
          <Button type="submit" className="w-full" disabled={login.isPending}>{t('Sign in')}</Button>
        </form>
      </Card>
    </div>
  );
}
