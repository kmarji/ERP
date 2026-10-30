import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FieldCrypto } from '../../common/crypto/field-crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { ExceptionService } from '../workflow-engine/exception.service';

// Official social security submission needs a verified integration and legal authorization (brief PAY-02).
export abstract class SscAdapter {
  abstract capabilities(): { submit: boolean; reason: string };
}

@Injectable()
export class StubSscAdapter extends SscAdapter {
  capabilities() {
    return { submit: false, reason: 'No verified social security integration is configured; HR submits manually and records the reference here.' };
  }
}

@Injectable()
export class SscService {
  private readonly log = new Logger(SscService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: SscAdapter,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly exceptions: ExceptionService,
  ) {}

  list(status?: string) {
    return this.prisma.db.sscAction.findMany({ where: { status: status as any }, orderBy: { preparedAt: 'desc' }, take: 200 });
  }

  async get(id: string) {
    const a = await this.prisma.db.sscAction.findFirst({ where: { id } });
    if (!a) throw new NotFoundException('SSC action not found');
    return a;
  }

  // The package is the only place the sensitive identity fields leave encrypted storage, and every use is audited.
  async guidedPackage(id: string, user: RequestUser) {
    const a = await this.get(id);
    const emp = await this.prisma.db.employee.findFirstOrThrow({ where: { id: a.employeeId } });
    const sensitive = emp.sensitive ? this.crypto.decrypt<{ nationalId?: string; dateOfBirth?: string }>(emp.sensitive) : {};
    await this.audit.record({ action: 'ssc.package_generated', entityType: 'SscAction', entityId: id, after: { by: user.id, kind: a.kind } });
    const cap = this.adapter.capabilities();
    return {
      method: cap.submit ? 'ADAPTER' : 'MANUAL',
      why: cap.reason,
      kind: a.kind,
      data: { ...(a.payload as object), nationalId: sensitive.nationalId, dateOfBirth: sensitive.dateOfBirth },
      steps: ['Sign in to the official social security portal with the authorized credentials.', `Enter the ${a.kind.toLowerCase()} details above for the employee.`, 'Submit and note the official reference number.', 'Record the reference here (record-submission), then confirm once the authority acknowledges it.'],
    };
  }

  async recordSubmission(id: string, input: { reference: string; submittedAt?: string }, user: RequestUser) {
    const a = await this.get(id);
    if (a.status !== 'PREPARED') throw new ConflictException(`Action is ${a.status}`);
    await this.prisma.db.sscAction.updateMany({ where: { id, status: 'PREPARED' }, data: { status: 'SUBMITTED', reference: input.reference, submittedAt: input.submittedAt ? new Date(input.submittedAt) : new Date() } });
    await this.audit.record({ action: 'ssc.submitted', entityType: 'SscAction', entityId: id, after: { reference: input.reference, by: user.id } });
    return this.get(id);
  }

  async confirm(id: string, input: { reference?: string }, user: RequestUser) {
    const a = await this.get(id);
    if (a.status !== 'SUBMITTED') throw new ConflictException(`Action is ${a.status}; record the submission first`);
    await this.prisma.db.sscAction.updateMany({ where: { id, status: 'SUBMITTED' }, data: { status: 'CONFIRMED', confirmedAt: new Date(), reference: input.reference ?? a.reference } });
    await this.audit.record({ action: 'ssc.confirmed', entityType: 'SscAction', entityId: id, after: { by: user.id } });
    return this.get(id);
  }

  async fail(id: string, input: { notes: string }) {
    const a = await this.get(id);
    if (!['PREPARED', 'SUBMITTED'].includes(a.status)) throw new ConflictException(`Action is ${a.status}`);
    await this.prisma.db.sscAction.updateMany({ where: { id }, data: { status: 'FAILED', notes: input.notes } });
    await this.exceptions.raise({ code: 'SSC_SUBMISSION_ISSUE', reason: `Social security ${a.kind.toLowerCase()} could not be completed: ${input.notes}`, evidence: { sscActionId: id, employeeId: a.employeeId }, ownerRole: 'HR', riskTier: 'MEDIUM', availableActions: ['resolve'] });
    await this.audit.record({ action: 'ssc.failed', entityType: 'SscAction', entityId: id, outcome: 'FAILURE', after: input });
    return this.get(id);
  }

  async flagOverdue() {
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const stale = await this.prisma.db.sscAction.findMany({ where: { status: 'PREPARED', preparedAt: { lt: cutoff } } });
    const open = await this.prisma.db.exception.findMany({ where: { code: 'SSC_OVERDUE', status: 'NOTIFIED' } });
    let raised = 0;
    for (const a of stale) {
      if (open.some((e) => (e.evidence as any)?.sscActionId === a.id)) continue;
      await this.exceptions.raise({ code: 'SSC_OVERDUE', reason: `Social security ${a.kind.toLowerCase()} prepared ${a.preparedAt.toISOString().slice(0, 10)} is still not submitted`, evidence: { sscActionId: a.id, employeeId: a.employeeId }, impact: 'Late registration may carry penalties', ownerRole: 'HR', riskTier: 'MEDIUM', availableActions: ['resolve'] });
      raised++;
    }
    return raised;
  }

  @Cron('30 6 * * *', { timeZone: 'Asia/Amman' })
  async sweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.flagOverdue()).catch((e) => this.log.error(`SSC sweep failed for ${t.id}: ${e.message}`));
  }
}
