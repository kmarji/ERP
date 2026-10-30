import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Cached GET of a list endpoint, shared by every select box (branches, products, items...).
export const useList = (path: string, enabled = true) => useQuery({ queryKey: ['list', path], queryFn: () => api<any[]>(path), enabled });

export const nameOf = (rows: any[] | undefined, id: string, field = 'name') => rows?.find((r) => r.id === id)?.[field] ?? id?.slice(0, 8);
