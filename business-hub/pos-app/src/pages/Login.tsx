import { useMutation } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn, Err, Input } from '../components/ui';
import { api, auth } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { downloadBundle, upgradeSession } from '../lib/offline';

export default function Login() {
  const nav = useNavigate();
  const { t } = useI18n();
  const [tenant, setTenant] = useState(localStorage.getItem('pos.tenant') ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api<{ accessToken: string }>('/auth/login', { body: { tenant, email, password } }),
    onSuccess: async (r) => {
      auth.set(r.accessToken);
      localStorage.setItem('pos.tenant', tenant);
      await upgradeSession();
      void downloadBundle();
      nav('/');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };
  return (
    <div className="flex h-full items-center justify-center bg-brand-900 p-6">
      <form onSubmit={submit} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6">
        <h1 className="text-2xl font-semibold">Business Hub POS</h1>
        <Err error={login.error} />
        <Input placeholder={t('Business')} value={tenant} onChange={(e) => setTenant(e.target.value)} autoCapitalize="none" />
        <Input type="email" placeholder={t('Email')} value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
        <Input type="password" placeholder={t('Password')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <Btn type="submit" className="w-full" disabled={login.isPending}>{t('Sign in')}</Btn>
      </form>
    </div>
  );
}
