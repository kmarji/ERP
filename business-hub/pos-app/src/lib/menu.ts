import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { getBundle } from './offline';

export interface Modifier { id: string; name: string; priceDelta: number }
export interface Group { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Modifier[] }
export interface Variant { id: string; name: string; nameAr?: string | null; priceDelta: number }
export interface MenuItem {
  id: string;
  name: string;
  nameAr?: string | null;
  categoryId: string | null;
  price: number; // tax-inclusive, branch price
  taxRate: number;
  available: boolean;
  variants: Variant[];
  groups: Group[];
}

// Online items come from /menu/items; the offline bundle has the same data in a flatter shape (categories and tables included).
function fromOnline(items: any[], taxCodes: any[]): MenuItem[] {
  const rate = new Map(taxCodes.map((t) => [t.id, Number(t.rate)]));
  return items
    .filter((i) => i.active)
    .map((i) => ({
      id: i.id,
      name: i.name,
      nameAr: i.nameAr,
      categoryId: i.categoryId,
      price: Number(i.effectivePrice ?? i.price),
      taxRate: i.taxCodeId ? rate.get(i.taxCodeId) ?? 0 : 0,
      available: i.available ?? true,
      variants: i.variants.map((v: any) => ({ ...v, priceDelta: Number(v.priceDelta) })),
      groups: i.modifierGroups.map((l: any) => ({ id: l.group.id, name: l.group.name, minSelect: l.group.minSelect, maxSelect: l.group.maxSelect, modifiers: l.group.modifiers.filter((m: any) => m.active).map((m: any) => ({ id: m.id, name: m.name, priceDelta: Number(m.priceDelta) })) })),
    }));
}

function fromBundle(items: any[]): MenuItem[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    nameAr: i.nameAr,
    categoryId: i.categoryId ?? null,
    price: Number(i.price),
    taxRate: Number(i.taxRate),
    available: i.available,
    variants: i.variants.map((v: any) => ({ ...v, priceDelta: Number(v.priceDelta) })),
    groups: i.modifierGroups.map((g: any) => ({ ...g, modifiers: g.modifiers.map((m: any) => ({ ...m, priceDelta: Number(m.priceDelta) })) })),
  }));
}

export function useMenu(branchId: string, offline: boolean) {
  return useQuery({
    queryKey: ['menu', branchId, offline],
    queryFn: async () => {
      if (offline) {
        const b = await getBundle();
        if (!b) throw new Error('No offline menu has been downloaded on this tablet yet.');
        return { items: fromBundle(b.menu.items), categories: [...(b.menu.categories ?? [])].sort((a, c) => a.sortOrder - c.sortOrder), source: 'cache' as const };
      }
      const [items, categories, taxCodes] = await Promise.all([api<any[]>(`/menu/items?branchId=${branchId}`), api<any[]>('/menu/categories'), api<any[]>('/tax-codes')]);
      return { items: fromOnline(items, taxCodes), categories: categories.filter((c) => c.active), source: 'live' as const };
    },
    staleTime: 60_000,
  });
}
