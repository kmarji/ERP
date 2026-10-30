import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';

export const MANAGERS = ['OWNER', 'HR', 'BRANCH_MANAGER'] as const;
export const DAY = 86_400_000;

// Jordan has no DST (UTC+3 all year), so local wall-clock times map to a fixed offset.
export const atLocal = (date: string, hhmm: string, plusDays = 0) => new Date(new Date(`${date.slice(0, 10)}T${hhmm}:00+03:00`).getTime() + plusDays * DAY);
export const minutes = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

// ISO week (Mon-Sun) containing a UTC-midnight date.
export function weekBounds(date: Date) {
  const start = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY);
  return { start, end: new Date(start.getTime() + 6 * DAY) };
}

export async function employeeOf(prisma: PrismaService, user: RequestUser) {
  const e = await prisma.db.employee.findFirst({ where: { userId: user.id } });
  if (!e) throw new NotFoundException('No employee record is linked to your login');
  return e;
}

export async function primaryBranch(prisma: PrismaService, employeeId: string, on: Date) {
  const rows = await prisma.db.employeeAssignment.findMany({ where: { employeeId, validFrom: { lte: on }, OR: [{ validTo: null }, { validTo: { gte: on } }] }, orderBy: { isPrimary: 'desc' } });
  return rows[0]?.branchId ?? null;
}
