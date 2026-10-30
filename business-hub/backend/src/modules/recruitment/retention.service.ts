import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { StorageAdapter } from '../documents/documents.adapters';

const ACTIVE_HIRING = ['ONBOARDING', 'OFFER_PENDING', 'HIRED'];

@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageAdapter,
    private readonly audit: AuditService,
  ) {}

  // Removes personal data and interview material but keeps a non-identifying record (status, vacancy, dates) so
  // hiring statistics and the audit trail survive. Used for erasure requests and the retention sweep.
  async anonymize(candidateId: string, reason: 'ERASURE_REQUEST' | 'RETENTION_EXPIRED') {
    const c = await this.prisma.db.candidate.findFirst({ where: { id: candidateId }, include: { applications: { include: { interview: true } } } });
    if (!c) throw new NotFoundException('Candidate not found');
    if (c.anonymizedAt) return { already: true };
    if (c.applications.some((a) => ACTIVE_HIRING.includes(a.status))) throw new ConflictException('This person is being hired or is employed; contact HR to handle their data');

    for (const a of c.applications) {
      const docIds = [a.interview?.recordingDocId].filter((x): x is string => !!x);
      const docs = await this.prisma.db.evidenceDocument.findMany({ where: { OR: [{ id: { in: docIds } }, { subjectType: 'Application', subjectId: a.id }, ...(a.interview ? [{ subjectType: 'Interview', subjectId: a.interview.id }] : [])] } });
      for (const doc of docs) await this.storage.delete(doc.storageKey).catch((e) => this.log.warn(`could not delete ${doc.storageKey}: ${e.message}`));
      await this.prisma.db.evidenceDocument.deleteMany({ where: { id: { in: docs.map((x) => x.id) } } });
      if (a.interview) await this.prisma.db.interview.updateMany({ where: { id: a.interview.id }, data: { transcript: [], consent: undefined, recordingDocId: null } });
      await this.prisma.db.evaluation.updateMany({ where: { applicationId: a.id }, data: { scores: [], reviewNotes: null } });
      await this.prisma.db.application.updateMany({ where: { id: a.id }, data: { intake: {}, missing: [], eligibility: [] } });
    }
    await this.prisma.db.candidate.updateMany({ where: { id: candidateId }, data: { name: 'Anonymized', phone: `anon-${candidateId}`, email: null, anonymizedAt: new Date() } });
    await this.audit.record({ action: 'candidate.anonymized', entityType: 'Candidate', entityId: candidateId, actorType: reason === 'RETENTION_EXPIRED' ? 'SYSTEM' : 'USER', after: { reason } });
    return { anonymized: true };
  }

  async sweep() {
    const due = await this.prisma.db.candidate.findMany({ where: { retentionUntil: { lt: new Date() }, anonymizedAt: null }, take: 500 });
    let n = 0;
    for (const c of due) {
      try {
        await this.anonymize(c.id, 'RETENTION_EXPIRED');
        n++;
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e; // still being hired: kept
      }
    }
    return n;
  }

  @Cron('30 3 * * *', { timeZone: 'Asia/Amman' })
  async nightly() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.sweep()).catch((e) => this.log.error(`retention sweep failed for ${t.id}: ${e.message}`));
  }
}
