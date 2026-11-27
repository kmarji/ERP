import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { ErrorBox } from '../components/ui';
import { api } from '../lib/api';
import OwnerHome from './OwnerHome';

// Where each role starts. Owner home is for the owner only; anyone else without a listed role starts in My space.
const START: [string, string][] = [['HR', '/people'], ['FINANCE', '/finance'], ['BRANCH_MANAGER', '/scheduling'], ['PURCHASING', '/purchasing']];

export default function Home() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/auth/me') });
  if (!me.data) return <ErrorBox error={me.error} />;
  const keys: string[] = me.data.roles.map((r: { key: string }) => r.key);
  if (me.data.isSystem || keys.includes('OWNER')) return <OwnerHome />;
  return <Navigate to={START.find(([role]) => keys.includes(role))?.[1] ?? '/me'} replace />;
}
