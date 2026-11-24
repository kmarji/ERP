import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { d } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { employeeOf, MANAGERS } from '../workforce/common';
import { ActionsService } from './actions.service';
import { OpsSettings } from './ops-settings';
import { branchFilter } from './scope';

// ponytail: Jordan is a fixed UTC+3 (no DST). Per-tenant time zones if the product leaves Jordan.
const TZ_OFFSET = '+03:00';
const GRACE_MS = 30 * 60_000;

// Scheduled slots today that are already due and still have no reading. A slot is covered by a reading taken
// from 30 min before it until 30 min before the next slot (so one reading never covers every earlier slot).
export function dueSlots(times: string[], readings: Date[], now: Date): string[] {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(now);
  const at = (t: string) => new Date(`${day}T${t}:00${TZ_OFFSET}`).getTime();
  const slots = [...new Set(times)].sort();
  return slots.filter((t, i) => {
    const from = at(t) - GRACE_MS;
    const to = i + 1 < slots.length ? at(slots[i + 1]) - GRACE_MS : Infinity;
    return at(t) <= now.getTime() && !readings.some((r) => r.getTime() >= from && r.getTime() < to);
  });
}

const OPEN = ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'];

// A58: measurements against thresholds; a breach raises an exception and one corrective action per point until it is closed.
@Injectable()
export class FoodSafetyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly actions: ActionsService, private readonly exceptions: ExceptionService, private readonly settings: OpsSettings) {}

  // Adds today's due-but-unrecorded slots to each scheduled point.
  private async withDue<T extends { id: string; readingTimes: string[] }>(points: T[]) {
    const now = new Date();
    const dayStart = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman' }).format(now)}T00:00:00${TZ_OFFSET}`);
    const scheduled = points.filter((p) => p.readingTimes.length);
    const rs = scheduled.length ? await this.prisma.db.foodSafetyReading.findMany({ where: { pointId: { in: scheduled.map((p) => p.id) }, takenAt: { gte: new Date(dayStart.getTime() - GRACE_MS) } }, select: { pointId: true, takenAt: true } }) : [];
    return points.map((p) => ({ ...p, dueSlots: p.readingTimes.length ? dueSlots(p.readingTimes, rs.filter((r) => r.pointId === p.id).map((r) => r.takenAt), now) : [] }));
  }

  async points(user: RequestUser, branchId?: string) {
    return this.withDue(await this.prisma.db.foodSafetyPoint.findMany({ where: branchFilter(user, branchId), orderBy: [{ branchId: 'asc' }, { name: 'asc' }] }));
  }

  async savePoint(input: { id?: string; branchId: string; name: string; kind: string; unit?: string; minValue?: number | null; maxValue?: number | null; active?: boolean; readingTimes?: string[] }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, MANAGERS);
    if (input.minValue == null && input.maxValue == null) throw new BadRequestException('Set a minimum, a maximum or both');
    if (input.minValue != null && input.maxValue != null && input.minValue > input.maxValue) throw new BadRequestException('Minimum is above maximum');
    const data = { name: input.name, kind: input.kind, unit: input.unit ?? 'C', minValue: input.minValue ?? null, maxValue: input.maxValue ?? null, active: input.active ?? true, ...(input.readingTimes ? { readingTimes: [...new Set(input.readingTimes)].sort() } : {}) }; // omitted = keep the current schedule
    let row;
    if (input.id) {
      const cur = await this.prisma.db.foodSafetyPoint.findFirst({ where: { id: input.id } });
      if (!cur || cur.branchId !== input.branchId) throw new NotFoundException('Point not found');
      await this.prisma.db.foodSafetyPoint.updateMany({ where: { id: input.id }, data });
      row = await this.prisma.db.foodSafetyPoint.findFirstOrThrow({ where: { id: input.id } });
    } else row = await this.prisma.db.foodSafetyPoint.create({ data: { tenantId: '', branchId: input.branchId, createdBy: user.id, ...data } });
    await this.audit.record({ action: 'food_safety.point_saved', entityType: 'FoodSafetyPoint', entityId: row.id, after: { ...data, branchId: input.branchId } });
    return row;
  }

  async myPoints(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const now = new Date();
    const branches = (await this.prisma.db.employeeAssignment.findMany({ where: { employeeId: me.id, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] } })).map((a) => a.branchId);
    return this.withDue(await this.prisma.db.foodSafetyPoint.findMany({ where: { branchId: { in: branches }, active: true }, orderBy: { name: 'asc' } }));
  }

  // Staff record at their own branch; managers at the branches they cover.
  async record(input: { pointId: string; value: number; note?: string; docId?: string }, user: RequestUser, as: 'employee' | 'manager') {
    const p = await this.prisma.db.foodSafetyPoint.findFirst({ where: { id: input.pointId } });
    if (!p || !p.active) throw new NotFoundException('Measurement point not found');
    if (as === 'manager') assertBranchAccess(user, p.branchId, MANAGERS);
    else if (!(await this.myPoints(user)).some((x) => x.id === p.id)) throw new ForbiddenException('This point is not at your branch');
    if (input.docId && !(await this.prisma.db.evidenceDocument.findFirst({ where: { id: input.docId } }))) throw new BadRequestException('Unknown evidence document');
    const v = d(input.value);
    const inRange = (p.minValue == null || v.gte(p.minValue)) && (p.maxValue == null || v.lte(p.maxValue));
    let actionId: string | null = null;
    if (!inRange) {
      const open = await this.prisma.db.correctiveAction.findFirst({ where: { source: 'FOOD_SAFETY', sourceId: p.id, status: { in: OPEN } } });
      const label = `${p.name} read ${v}${p.unit} (allowed ${p.minValue ?? '-'} to ${p.maxValue ?? '-'})`;
      if (open) {
        actionId = open.id;
        await this.prisma.db.correctiveAction.updateMany({ where: { id: open.id }, data: { history: [...(open.history as any[]), { at: new Date().toISOString(), by: user.id, event: 'repeat_breach', note: label }] } });
      } else {
        actionId = (await this.actions.create({ branchId: p.branchId, source: 'FOOD_SAFETY', sourceId: p.id, title: `Out of range: ${label}`, description: input.note, severity: 'HIGH', dueAt: new Date(Date.now() + (await this.settings.get()).foodSafetyActionHours * 3_600_000) }, user.id)).id;
        await this.exceptions.raise({ code: 'OPS_FOOD_SAFETY', reason: label, evidence: { pointId: p.id, actionId }, impact: 'Possible food safety risk; the exception escalates to the owner if it is not handled in time', branchId: p.branchId, ownerRole: 'BRANCH_MANAGER', riskTier: 'HIGH', availableActions: ['resolve'] });
      }
    }
    const row = await this.prisma.db.foodSafetyReading.create({ data: { tenantId: '', pointId: p.id, branchId: p.branchId, value: v, inRange, takenBy: user.id, note: input.note ?? null, docId: input.docId ?? null, actionId } });
    await this.audit.record({ action: inRange ? 'food_safety.reading' : 'food_safety.breach', entityType: 'FoodSafetyReading', entityId: row.id, after: { pointId: p.id, value: v.toString(), inRange } });
    return row;
  }

  readings(f: { branchId?: string; pointId?: string; from?: string; outOfRange?: string }, user: RequestUser) {
    return this.prisma.db.foodSafetyReading.findMany({ where: { ...branchFilter(user, f.branchId), pointId: f.pointId, inRange: f.outOfRange === '1' ? false : undefined, takenAt: f.from ? { gte: new Date(f.from) } : undefined }, orderBy: { takenAt: 'desc' }, take: 300 });
  }
}
