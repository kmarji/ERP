import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { employeeOf } from '../workforce/common';

// Salary and employment certificates. The employee asks; a company-wide HR or owner approves; the figures are frozen at approval.
@Injectable()
export class LettersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notes: NotificationsService) {}

  private hr(u: RequestUser) {
    if (!u.roles.some((r) => r.branchId === null && ['HR', 'OWNER'].includes(r.key))) throw new ForbiddenException('Only company-wide HR or the owner can decide letters');
  }

  async request(u: RequestUser, input: { kind: 'SALARY' | 'EMPLOYMENT'; addressee: string; purpose?: string }) {
    const me = await employeeOf(this.prisma, u);
    if (me.status !== 'ACTIVE') throw new BadRequestException('Letters are issued to active employees only');
    if ((await this.prisma.db.employeeLetter.count({ where: { employeeId: me.id, status: 'PENDING' } })) >= 3) throw new ConflictException('You already have 3 letters waiting for HR');
    const row = await this.prisma.db.employeeLetter.create({ data: { tenantId: '', employeeId: me.id, kind: input.kind, addressee: input.addressee.trim(), purpose: input.purpose?.trim() || null } });
    await this.audit.record({ action: 'letter.requested', entityType: 'EmployeeLetter', entityId: row.id, after: { kind: input.kind } });
    await this.notes.notify({ roleKey: 'HR', title: `${me.name} requested a ${input.kind.toLowerCase()} letter` });
    return row;
  }

  async mine(u: RequestUser) {
    const me = await employeeOf(this.prisma, u);
    return this.prisma.db.employeeLetter.findMany({ where: { employeeId: me.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  // Only the owner of an approved letter can read its frozen content.
  async mineOne(id: string, u: RequestUser) {
    const me = await employeeOf(this.prisma, u);
    const l = await this.prisma.db.employeeLetter.findFirst({ where: { id, employeeId: me.id, status: 'APPROVED' } });
    if (!l) throw new NotFoundException('Letter not found');
    return l;
  }

  async list(u: RequestUser, status?: string) {
    this.hr(u);
    const rows = await this.prisma.db.employeeLetter.findMany({ where: { status: status || undefined }, orderBy: { createdAt: 'desc' }, take: 200 });
    const emps = await this.prisma.db.employee.findMany({ where: { id: { in: rows.map((r) => r.employeeId) } }, select: { id: true, name: true, number: true } });
    return rows.map((r) => ({ ...r, employee: emps.find((e) => e.id === r.employeeId) }));
  }

  async decide(id: string, approve: boolean, note: string | undefined, u: RequestUser) {
    this.hr(u);
    const l = await this.prisma.db.employeeLetter.findFirst({ where: { id } });
    if (!l) throw new NotFoundException('Letter not found');
    if (l.status !== 'PENDING') throw new ConflictException(`Letter already ${l.status}`);
    const e = await this.prisma.db.employee.findFirstOrThrow({ where: { id: l.employeeId } });
    if (!approve && !note?.trim()) throw new BadRequestException('Say why the letter was rejected');
    let content: Record<string, unknown> | undefined;
    if (approve) {
      const [entity, position, contract] = await Promise.all([
        this.prisma.db.legalEntity.findFirst({ where: { id: e.legalEntityId } }),
        this.prisma.db.jobPosition.findFirst({ where: { id: e.positionId } }),
        this.prisma.db.employmentContract.findFirst({ where: { employeeId: e.id, status: 'ACTIVE' }, orderBy: { version: 'desc' } }),
      ]);
      const allowances = ((contract?.allowances as { amount: number }[]) ?? []).reduce((s, a) => s + Number(a.amount), 0);
      content = {
        company: entity?.name ?? '', currency: entity?.currency ?? 'JOD', employeeName: e.name, employeeNameAr: e.nameAr, employeeNumber: e.number,
        position: position?.title ?? '', positionAr: position?.titleAr ?? null, hireDate: e.hireDate.toISOString().slice(0, 10), contractType: contract?.type ?? null,
        ...(l.kind === 'SALARY' && contract ? { salary: { basic: contract.salaryBasic.toString(), allowances: allowances.toFixed(3), total: contract.salaryBasic.plus(allowances).toFixed(3) } } : {}),
        issuedAt: new Date().toISOString().slice(0, 10),
      };
    }
    const res = await this.prisma.db.employeeLetter.updateMany({ where: { id, status: 'PENDING' }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedBy: u.id, decidedAt: new Date(), decisionNote: note?.trim() || null, number: approve ? `LTR-${id.slice(0, 8).toUpperCase()}` : null, content: content as any } });
    if (res.count !== 1) throw new ConflictException('Letter already decided');
    await this.audit.record({ action: approve ? 'letter.approved' : 'letter.rejected', entityType: 'EmployeeLetter', entityId: id, after: { by: u.id, kind: l.kind } });
    if (e.userId) await this.notes.notify({ userId: e.userId, title: approve ? 'Your letter is ready' : 'Your letter request was rejected', body: note });
    return this.prisma.db.employeeLetter.findFirstOrThrow({ where: { id } });
  }
}
