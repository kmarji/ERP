import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { money } from '../../common/money';
import { FieldCrypto } from '../../common/crypto/field-crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { dateOnly } from '../../common/time';
import { AuditService } from '../audit/audit.service';

const HQ_ROLES = ['HR', 'OWNER', 'FINANCE'];
const strip = <T extends { sensitive?: unknown }>(e: T) => {
  const { sensitive: _s, ...rest } = e;
  return rest;
};

@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
  ) {}

  // HQ-wide HR/finance/owner see everyone; a branch manager only people assigned to a branch they manage.
  private isHq(u: RequestUser) {
    return u.roles.some((r) => HQ_ROLES.includes(r.key) && r.branchId === null) || u.delegations.some((x) => HQ_ROLES.includes(x.roleKey) && x.branchId === null);
  }

  private async assertCanSee(id: string, u: RequestUser) {
    const e = await this.prisma.db.employee.findFirst({ where: { id }, include: { assignments: true } });
    if (!e) throw new NotFoundException('Employee not found');
    if (this.isHq(u)) return e;
    const ok = e.assignments.some((a) => {
      try {
        assertBranchAccess(u, a.branchId, ['BRANCH_MANAGER']);
        return true;
      } catch {
        return false;
      }
    });
    if (!ok) throw new ForbiddenException('This employee is not assigned to a branch you manage');
    return e;
  }

  async list(u: RequestUser, f: { branchId?: string; status?: string; q?: string }) {
    if (!this.isHq(u)) {
      if (!f.branchId) throw new BadRequestException('branchId is required');
      assertBranchAccess(u, f.branchId, ['BRANCH_MANAGER']);
    }
    const rows = await this.prisma.db.employee.findMany({
      where: {
        status: f.status as any,
        ...(f.branchId ? { assignments: { some: { branchId: f.branchId } } } : {}),
        ...(f.q ? { OR: [{ name: { contains: f.q, mode: 'insensitive' } }, { number: { contains: f.q, mode: 'insensitive' } }] } : {}),
      },
      include: { assignments: true },
      orderBy: { number: 'asc' },
      take: 500,
    });
    return rows.map(strip);
  }

  async get(id: string, u: RequestUser) {
    const e = await this.assertCanSee(id, u);
    const [contract, training] = await Promise.all([
      this.prisma.db.employmentContract.findFirst({ where: { employeeId: id, status: 'ACTIVE' }, orderBy: { version: 'desc' } }),
      this.prisma.db.trainingAssignment.findMany({ where: { employeeId: id } }),
    ]);
    // Pay is only for HR, owner and finance.
    return { ...strip(e), activeContract: this.isHq(u) ? contract : contract && { ...contract, salaryBasic: undefined, allowances: undefined }, training };
  }

  async sensitive(id: string, u: RequestUser) {
    const e = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!e) throw new NotFoundException('Employee not found');
    await this.audit.record({ action: 'employee.sensitive_viewed', entityType: 'Employee', entityId: id, after: { viewer: u.id } });
    return e.sensitive ? this.crypto.decrypt(e.sensitive) : {};
  }

  async patch(id: string, data: { name?: string; nameAr?: string; phone?: string; email?: string }) {
    const before = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!before) throw new NotFoundException('Employee not found');
    await this.prisma.db.employee.updateMany({ where: { id }, data });
    await this.audit.record({ action: 'employee.updated', entityType: 'Employee', entityId: id, before: { name: before.name, phone: before.phone, email: before.email }, after: data });
    return strip(await this.prisma.db.employee.findFirstOrThrow({ where: { id } }));
  }

  // ---------------------------------------------------------------- assignments (one employer, several branches)

  async addAssignment(id: string, input: { branchId: string; isPrimary?: boolean; validFrom: string; validTo?: string }) {
    const [e, branch] = await Promise.all([this.prisma.db.employee.findFirst({ where: { id } }), this.prisma.db.branch.findFirst({ where: { id: input.branchId } })]);
    if (!e) throw new NotFoundException('Employee not found');
    if (!branch) throw new BadRequestException('Unknown branch');
    return this.prisma.db.$transaction(async (tx) => {
      if (input.isPrimary) await tx.employeeAssignment.updateMany({ where: { employeeId: id, isPrimary: true, validTo: null }, data: { isPrimary: false } });
      const a = await tx.employeeAssignment.create({ data: { tenantId: '', employeeId: id, branchId: input.branchId, isPrimary: !!input.isPrimary, validFrom: dateOnly(input.validFrom), validTo: input.validTo ? dateOnly(input.validTo) : null } });
      await this.audit.record({ action: 'employee.assignment_added', entityType: 'Employee', entityId: id, after: { branchId: input.branchId, primary: !!input.isPrimary } }, tx);
      return a;
    });
  }

  async endAssignment(id: string, aid: string, validTo?: string) {
    const a = await this.prisma.db.employeeAssignment.findFirst({ where: { id: aid, employeeId: id } });
    if (!a) throw new NotFoundException('Assignment not found');
    if (a.validTo) throw new ConflictException('Assignment already ended');
    await this.prisma.db.employeeAssignment.updateMany({ where: { id: aid }, data: { validTo: validTo ? dateOnly(validTo) : dateOnly(new Date().toISOString()) } });
    await this.audit.record({ action: 'employee.assignment_ended', entityType: 'Employee', entityId: id, after: { assignmentId: aid } });
    return this.prisma.db.employeeAssignment.findFirstOrThrow({ where: { id: aid } });
  }

  // ---------------------------------------------------------------- contracts (history is kept: a change is a new version)

  async newContract(id: string, input: { effectiveDate: string; type?: string; salaryBasic: number; allowances?: { name: string; amount: number }[]; weeklyHours?: number; probationMonths?: number; endDate?: string }, u: RequestUser) {
    const e = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!e) throw new NotFoundException('Employee not found');
    return this.prisma.db.$transaction(async (tx) => {
      const prev = await tx.employmentContract.findFirst({ where: { employeeId: id, status: 'ACTIVE' }, orderBy: { version: 'desc' } });
      const last = await tx.employmentContract.findFirst({ where: { employeeId: id }, orderBy: { version: 'desc' } });
      const effective = dateOnly(input.effectiveDate);
      if (prev && effective <= prev.startDate) throw new BadRequestException('The effective date must be after the current contract started');
      if (prev) await tx.employmentContract.updateMany({ where: { id: prev.id }, data: { status: 'SUPERSEDED', endDate: new Date(effective.getTime() - 86_400_000) } });
      const c = await tx.employmentContract.create({
        data: { tenantId: '', employeeId: id, version: (last?.version ?? 0) + 1, type: input.type ?? prev?.type ?? 'OPEN', startDate: effective, endDate: input.endDate ? dateOnly(input.endDate) : null, salaryBasic: money(input.salaryBasic), allowances: (input.allowances ?? prev?.allowances ?? []) as any, weeklyHours: input.weeklyHours ?? prev?.weeklyHours ?? 48, probationMonths: input.probationMonths ?? 0 },
      });
      await this.audit.record({ action: 'employee.contract_changed', entityType: 'Employee', entityId: id, before: prev && { version: prev.version, salaryBasic: prev.salaryBasic.toString() }, after: { version: c.version, salaryBasic: c.salaryBasic.toString(), effective: input.effectiveDate, by: u.id } }, tx);
      return c;
    });
  }

  contracts(id: string) {
    return this.prisma.db.employmentContract.findMany({ where: { employeeId: id }, orderBy: { version: 'desc' } });
  }

  // ---------------------------------------------------------------- training

  async training(id: string, u: RequestUser) {
    await this.assertCanSeeOrSelf(id, u);
    return this.prisma.db.trainingAssignment.findMany({ where: { employeeId: id }, orderBy: { dueDate: 'asc' } });
  }

  private async assertCanSeeOrSelf(id: string, u: RequestUser) {
    const e = await this.prisma.db.employee.findFirst({ where: { id } });
    if (e?.userId && e.userId === u.id) return e;
    return this.assertCanSee(id, u);
  }

  async addTraining(id: string, input: { title: string; mandatory?: boolean; dueDate?: string }) {
    if (!(await this.prisma.db.employee.findFirst({ where: { id } }))) throw new NotFoundException('Employee not found');
    return this.prisma.db.trainingAssignment.create({ data: { tenantId: '', employeeId: id, title: input.title, mandatory: input.mandatory ?? true, dueDate: input.dueDate ? dateOnly(input.dueDate) : null } });
  }

  async completeTraining(trainingId: string, u: RequestUser) {
    const t = await this.prisma.db.trainingAssignment.findFirst({ where: { id: trainingId } });
    if (!t) throw new NotFoundException('Training assignment not found');
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: t.employeeId } });
    const hr = actorHasRole(u, 'HR') || actorHasRole(u, 'OWNER');
    if (!hr && emp.userId !== u.id) throw new ForbiddenException('You can only complete your own training');
    if (t.status === 'DONE') return t;
    await this.prisma.db.trainingAssignment.updateMany({ where: { id: trainingId, status: 'ASSIGNED' }, data: { status: 'DONE', completedAt: new Date() } });
    await this.audit.record({ action: 'training.completed', entityType: 'TrainingAssignment', entityId: trainingId, after: { by: u.id } });
    return this.prisma.db.trainingAssignment.findFirstOrThrow({ where: { id: trainingId } });
  }
}
