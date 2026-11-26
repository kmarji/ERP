import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { money } from '../../common/money';
import { FieldCrypto } from '../../common/crypto/field-crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { ammanToday, dateOnly } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { permitStatus } from './work-permit';
import { WorkPermitService } from './work-permit.service';

const HQ_ROLES = ['HR', 'OWNER', 'FINANCE'];
// Never leaks the encrypted blob or the pay ratios; get() adds the ratios back for HQ roles only.
const strip = <T extends { sensitive?: unknown }>(e: T) => {
  const { sensitive: _s, sscEmployeeRate: _a, sscEmployerRate: _b, sscRateNote: _c, incomeTaxRate: _d, incomeTaxRateNote: _e, workPermitAlertStage: _f, ...rest } = e as any;
  return rest as Omit<T, 'sensitive'>;
};
const rates = (e: any) => ({ sscEmployeeRate: e.sscEmployeeRate, sscEmployerRate: e.sscEmployerRate, sscRateNote: e.sscRateNote, incomeTaxRate: e.incomeTaxRate, incomeTaxRateNote: e.incomeTaxRateNote });

@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly permits: WorkPermitService,
  ) {}

  // What a viewer gets for one employee: the badge for everyone, the permit number only for company-wide roles.
  private view(e: any, u: RequestUser) {
    const { workPermitNumber, ...rest } = strip(e) as any;
    return { ...rest, ...(this.isHq(u) ? { workPermitNumber } : {}), permit: permitStatus(e, ammanToday()) };
  }

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
    return rows.map((e) => this.view(e, u));
  }

  async get(id: string, u: RequestUser) {
    const e = await this.assertCanSee(id, u);
    const [contract, training] = await Promise.all([
      this.prisma.db.employmentContract.findFirst({ where: { employeeId: id, status: 'ACTIVE' }, orderBy: { version: 'desc' } }),
      this.prisma.db.trainingAssignment.findMany({ where: { employeeId: id } }),
    ]);
    // Pay is only for HR, owner and finance.
    return { ...this.view(e, u), ...(this.isHq(u) ? rates(e) : {}), activeContract: this.isHq(u) ? contract : contract && { ...contract, salaryBasic: undefined, allowances: undefined }, training };
  }

  async sensitive(id: string, u: RequestUser) {
    const e = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!e) throw new NotFoundException('Employee not found');
    await this.audit.record({ action: 'employee.sensitive_viewed', entityType: 'Employee', entityId: id, after: { viewer: u.id } });
    return e.sensitive ? this.crypto.decrypt(e.sensitive) : {};
  }

  // Company-wide HR or owner only: changing the IBAN changes where salary is paid. Values never reach the audit trail.
  async setSensitive(id: string, u: RequestUser, input: { nationalId?: string; dateOfBirth?: string; address?: string; iban?: string }) {
    if (!u.roles.some((r) => ['HR', 'OWNER'].includes(r.key) && r.branchId === null)) throw new ForbiddenException('Only company-wide HR or the owner can change sensitive details');
    const e = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!e) throw new NotFoundException('Employee not found');
    // A blob that cannot be decrypted throws here, so it is never overwritten.
    const next: Record<string, string> = e.sensitive ? this.crypto.decrypt(e.sensitive) : {};
    const fields: string[] = [];
    for (const key of ['nationalId', 'dateOfBirth', 'address', 'iban'] as const) {
      let value = input[key]?.trim();
      if (value === undefined) continue;
      if (key === 'iban') value = value.replace(/ /g, '').toUpperCase();
      if (value === (next[key] ?? '')) continue;
      fields.push(key);
      if (value) next[key] = value;
      else delete next[key];
    }
    if (fields.length) {
      await this.prisma.db.$transaction(async (tx) => {
        await tx.employee.updateMany({ where: { id }, data: { sensitive: this.crypto.encrypt(next) } });
        await this.audit.record({ action: 'employee.sensitive_changed', entityType: 'Employee', entityId: id, after: { fields, by: u.id } }, tx);
      });
    }
    return next;
  }

  async patch(id: string, u: RequestUser, input: { name?: string; nameAr?: string; phone?: string; email?: string; managerId?: string | null; nationality?: string; needsWorkPermit?: boolean; workPermitNumber?: string | null; workPermitExpiry?: string | null }) {
    const { workPermitNumber, workPermitExpiry, ...data } = input;
    const before = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!before) throw new NotFoundException('Employee not found');
    const permitSent = data.needsWorkPermit !== undefined || workPermitNumber !== undefined || workPermitExpiry !== undefined;
    if (permitSent && !this.isHq(u)) throw new ForbiddenException('Only company-wide roles can change a work permit');
    if (data.managerId !== undefined && !this.isHq(u)) throw new ForbiddenException('Only company-wide roles can set who an employee reports to');
    if (data.managerId) {
      if (data.managerId === id) throw new BadRequestException('An employee cannot be their own manager');
      const m = await this.prisma.db.employee.findFirst({ where: { id: data.managerId } });
      if (!m?.userId || m.status !== 'ACTIVE') throw new BadRequestException('The manager must be an active employee with a login');
      if (m.managerId === id) throw new BadRequestException('That manager already reports to this employee');
    }
    // Without the checkbox there is no permit; a new expiry date restarts the alert stages.
    const needed = data.needsWorkPermit ?? before.needsWorkPermit;
    const number = !needed ? null : workPermitNumber === undefined ? undefined : workPermitNumber?.trim() || null;
    const expiry = !needed ? null : workPermitExpiry === undefined ? undefined : workPermitExpiry ? dateOnly(workPermitExpiry) : null;
    const restart = expiry !== undefined && expiry?.getTime() !== before.workPermitExpiry?.getTime();
    await this.prisma.db.employee.updateMany({ where: { id }, data: { ...data, workPermitNumber: number, workPermitExpiry: expiry, ...(restart ? { workPermitAlertStage: null } : {}) } });
    const { name, phone, email, managerId, nationality, needsWorkPermit } = before;
    await this.audit.record({ action: 'employee.updated', entityType: 'Employee', entityId: id, before: { name, phone, email, managerId, nationality, needsWorkPermit, workPermitNumber: before.workPermitNumber, workPermitExpiry: before.workPermitExpiry }, after: input });
    await this.permits.alertAfterSave(id);
    return this.view(await this.prisma.db.employee.findFirstOrThrow({ where: { id } }), u);
  }

  // Fixed SSC / income-tax ratios for one employee (fractions). null clears back to the rule set; a set ratio needs a reason.
  async setPayrollRates(id: string, u: RequestUser, input: { sscEmployeeRate?: number | null; sscEmployerRate?: number | null; sscRateNote?: string | null; incomeTaxRate?: number | null; incomeTaxRateNote?: string | null }) {
    if (!this.isHq(u)) throw new ForbiddenException('Only company-wide roles can set payroll ratios');
    const before = await this.prisma.db.employee.findFirst({ where: { id } });
    if (!before) throw new NotFoundException('Employee not found');
    const sscSet = input.sscEmployeeRate != null || input.sscEmployerRate != null;
    if (sscSet && !input.sscRateNote?.trim()) throw new BadRequestException('Say why this social security ratio is set (note required)');
    if (input.incomeTaxRate != null && !input.incomeTaxRateNote?.trim()) throw new BadRequestException('Say why this income tax ratio is set (note required)');
    const data = {
      sscEmployeeRate: input.sscEmployeeRate ?? null, sscEmployerRate: input.sscEmployerRate ?? null, sscRateNote: sscSet ? input.sscRateNote!.trim() : null,
      incomeTaxRate: input.incomeTaxRate ?? null, incomeTaxRateNote: input.incomeTaxRate != null ? input.incomeTaxRateNote!.trim() : null,
    };
    await this.prisma.db.employee.updateMany({ where: { id }, data });
    const pick = (e: typeof data) => ({ ...e, sscEmployeeRate: e.sscEmployeeRate?.toString() ?? null, sscEmployerRate: e.sscEmployerRate?.toString() ?? null, incomeTaxRate: e.incomeTaxRate?.toString() ?? null });
    await this.audit.record({ action: 'employee.payroll_rates_changed', entityType: 'Employee', entityId: id, before: pick(before as any), after: { ...pick(data as any), by: u.id } });
    return rates(await this.prisma.db.employee.findFirstOrThrow({ where: { id } }));
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
      await this.audit.record({ action: 'employee.contract_changed', entityType: 'Employee', entityId: id, before: prev && { version: prev.version, salaryBasic: prev.salaryBasic.toString(), allowances: prev.allowances }, after: { version: c.version, salaryBasic: c.salaryBasic.toString(), allowances: c.allowances, effective: input.effectiveDate, by: u.id } }, tx);
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

  async completeTraining(trainingId: string, u: RequestUser) {
    const t = await this.prisma.db.trainingAssignment.findFirst({ where: { id: trainingId } });
    if (!t) throw new NotFoundException('Training assignment not found');
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: t.employeeId } });
    const hr = actorHasRole(u, 'HR') || actorHasRole(u, 'OWNER');
    if (!hr && emp.userId !== u.id) throw new ForbiddenException('You can only complete your own training');
    if (t.itemCode) throw new ForbiddenException('This training is completed by passing its exam');
    if (t.status === 'DONE') return t;
    await this.prisma.db.trainingAssignment.updateMany({ where: { id: trainingId, status: 'ASSIGNED' }, data: { status: 'DONE', completedAt: new Date() } });
    await this.audit.record({ action: 'training.completed', entityType: 'TrainingAssignment', entityId: trainingId, after: { by: u.id } });
    return this.prisma.db.trainingAssignment.findFirstOrThrow({ where: { id: trainingId } });
  }
}
