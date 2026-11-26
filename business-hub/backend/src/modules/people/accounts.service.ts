import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { assertRankBelowHr } from '../../common/permissions';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { WorkPermitService } from './work-permit.service';
import { dateOnly } from '../../common/time';
import { Profile, profileData } from './profile-fields';

export interface NewEmployee extends Profile {
  probationMonths?: number;
  name: string; nameAr?: string; phone: string; email?: string;
  nationality: string; needsWorkPermit?: boolean; workPermitNumber?: string; workPermitExpiry?: string;
  legalEntityId: string; branchId: string; positionId: string; hireDate: string;
  contractType?: string; salaryBasic: number; allowances?: { name: string; amount: number }[]; weeklyHours?: number;
  managerId?: string;
  login?: { email: string; password: string; roleKey?: string };
}

// Creating employees and their logins. Company-wide HR or owner only: a login carries a role, so it is a permission decision.
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sequences: SequenceService, private readonly permits: WorkPermitService) {}

  private assertHq(u: RequestUser) {
    if (!(u.roles.some((r) => ['HR', 'OWNER'].includes(r.key) && r.branchId === null))) throw new ForbiddenException('Only company-wide HR or the owner can manage logins');
  }

  private async newUser(tx: any, u: RequestUser, name: string, login: { email: string; password: string; roleKey?: string }, branchId: string) {
    const roleKey = login.roleKey ?? 'EMPLOYEE';
    if (roleKey === 'OWNER' && !actorHasRole(u, 'OWNER')) throw new ForbiddenException('Only an owner can grant OWNER');
    if (roleKey === 'SYSTEM') throw new BadRequestException('SYSTEM is reserved for automation');
    await assertRankBelowHr(tx, actorHasRole(u, 'OWNER'), [roleKey]);
    const role = await tx.role.findFirst({ where: { key: roleKey } });
    if (!role) throw new NotFoundException(`Role ${roleKey} not found`);
    const email = login.email.toLowerCase();
    if (await tx.user.findFirst({ where: { email } })) throw new ConflictException('That email already has a login');
    const user = await tx.user.create({ data: { tenantId: '', email, name, passwordHash: await bcrypt.hash(login.password, 10) } });
    // The base EMPLOYEE role is always kept so the portal works; a higher role is added on top.
    const keys = roleKey === 'EMPLOYEE' ? ['EMPLOYEE'] : ['EMPLOYEE', roleKey];
    for (const k of keys) {
      const r = k === roleKey ? role : await tx.role.findFirst({ where: { key: k } });
      if (r) await tx.userRole.create({ data: { tenantId: '', userId: user.id, roleId: r.id, branchId } });
    }
    return user;
  }

  async create(u: RequestUser, dto: NewEmployee) {
    this.assertHq(u);
    const [entity, branch, position] = await Promise.all([
      this.prisma.db.legalEntity.findFirst({ where: { id: dto.legalEntityId } }),
      this.prisma.db.branch.findFirst({ where: { id: dto.branchId } }),
      this.prisma.db.jobPosition.findFirst({ where: { id: dto.positionId } }),
    ]);
    if (!entity || !branch || !position) throw new NotFoundException('Legal entity, branch or position not found');
    if (dto.managerId) {
      const m = await this.prisma.db.employee.findFirst({ where: { id: dto.managerId, status: 'ACTIVE', userId: { not: null } } });
      if (!m) throw new BadRequestException('The manager must be an active employee with a login');
    }
    const hire = new Date(`${dto.hireDate.slice(0, 10)}T00:00:00.000Z`);
    const id = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('EMP', 'EMP', tx);
      const emp = await tx.employee.create({ data: { tenantId: '', number, legalEntityId: entity.id, name: dto.name, nameAr: dto.nameAr ?? null, ...profileData(dto), probationMonths: dto.probationMonths, nationality: dto.nationality, needsWorkPermit: !!dto.needsWorkPermit, workPermitNumber: (dto.needsWorkPermit && dto.workPermitNumber?.trim()) || null, workPermitExpiry: dto.needsWorkPermit && dto.workPermitExpiry ? dateOnly(dto.workPermitExpiry) : null, phone: dto.phone, email: (dto.email ?? dto.login?.email)?.toLowerCase() ?? null, status: hire <= new Date() ? 'ACTIVE' : 'ONBOARDING', hireDate: hire, positionId: position.id, managerId: dto.managerId ?? null } });
      await tx.employeeAssignment.create({ data: { tenantId: '', employeeId: emp.id, branchId: branch.id, isPrimary: true, validFrom: hire } });
      await tx.employmentContract.create({ data: { tenantId: '', employeeId: emp.id, version: 1, type: dto.contractType ?? 'PERMANENT', startDate: hire, salaryBasic: dto.salaryBasic, allowances: dto.allowances ?? [], weeklyHours: dto.weeklyHours ?? 48, probationMonths: dto.probationMonths } });
      if (dto.login) {
        const user = await this.newUser(tx, u, dto.name, dto.login, branch.id);
        await tx.employee.updateMany({ where: { id: emp.id }, data: { userId: user.id } });
      }
      await this.audit.record({ action: 'employee.created_manually', entityType: 'Employee', entityId: emp.id, after: { number, login: !!dto.login, roleKey: dto.login?.roleKey ?? 'EMPLOYEE' } }, tx);
      return emp.id;
    });
    await this.permits.alertAfterSave(id);
    return this.prisma.db.employee.findFirstOrThrow({ where: { id }, select: { id: true, number: true, name: true, status: true, userId: true } });
  }

  private async employee(id: string) {
    const e = await this.prisma.db.employee.findFirst({ where: { id }, include: { assignments: true } });
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }

  async access(id: string, u: RequestUser) {
    this.assertHq(u);
    const e = await this.employee(id);
    if (!e.userId) return { user: null, roles: [] };
    const user = await this.prisma.db.user.findFirst({ where: { id: e.userId }, select: { id: true, email: true, active: true, roles: { include: { role: true } } } });
    return { user: user && { id: user.id, email: user.email, active: user.active }, roles: (user?.roles ?? []).map((r) => ({ id: r.id, key: r.role.key, name: r.role.name, branchId: r.branchId, legalEntityId: r.legalEntityId })) };
  }

  async createLogin(id: string, u: RequestUser, login: { email: string; password: string; roleKey?: string }) {
    this.assertHq(u);
    const e = await this.employee(id);
    if (e.userId) throw new ConflictException('This employee already has a login');
    const branchId = e.assignments.find((a) => a.isPrimary && !a.validTo)?.branchId ?? e.assignments[0]?.branchId;
    if (!branchId) throw new ConflictException('Assign the employee to a branch first');
    await this.prisma.db.$transaction(async (tx) => {
      const user = await this.newUser(tx, u, e.name, login, branchId);
      await tx.employee.updateMany({ where: { id, userId: null }, data: { userId: user.id, email: e.email ?? user.email } });
      await this.audit.record({ action: 'employee.login_created', entityType: 'Employee', entityId: id, after: { userId: user.id, roleKey: login.roleKey ?? 'EMPLOYEE' } }, tx);
    });
    return this.access(id, u);
  }

  async resetPassword(id: string, u: RequestUser, password: string) {
    this.assertHq(u);
    const e = await this.employee(id);
    if (!e.userId) throw new ConflictException('This employee has no login yet');
    const target = await this.prisma.db.user.findFirst({ where: { id: e.userId }, include: { roles: { include: { role: true } } } });
    // Resetting an owner's password would be a takeover path for HR.
    const now = new Date();
    const delegated = await this.prisma.db.delegation.findMany({ where: { toUserId: e.userId, endsAt: { gte: now }, revokedAt: null } });
    await assertRankBelowHr(this.prisma.db, actorHasRole(u, 'OWNER'), [...(target?.roles.map((r) => r.role.key) ?? []), ...delegated.map((d) => d.roleKey)]);
    if (e.userId === u.id && !actorHasRole(u, 'OWNER')) throw new ForbiddenException('Ask an owner to change your own password here');
    await this.prisma.db.user.updateMany({ where: { id: e.userId }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    await this.audit.record({ action: 'employee.password_reset', entityType: 'User', entityId: e.userId });
    return { reset: true };
  }
}
