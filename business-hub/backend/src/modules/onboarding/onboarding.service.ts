import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { d, money } from '../../common/money';
import { FieldCrypto } from '../../common/crypto/field-crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { ammanToday, dateOnly } from '../../common/time';
import { currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.module';
import { NotificationsService } from '../notifications/notifications.module';
import { PolicyService } from '../policy-engine/policy.service';
import { CandidateNotifier } from '../recruitment/candidate-notifier';
import { WF03 } from '../recruitment/recruitment.workflow';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { buildContract } from './contract';

export interface OfferInput {
  startDate: string;
  salaryBasic: number;
  allowances?: { name: string; amount: number }[];
  contractType?: 'OPEN' | 'FIXED_TERM';
  endDate?: string;
  probationMonths?: number;
  weeklyHours?: number;
}

const OFFER_ACTION = 'offer.approve';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly workflow: WorkflowEngineService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly docs: DocumentsService,
    private readonly notifier: CandidateNotifier,
    private readonly notifications: NotificationsService,
    private readonly crypto: FieldCrypto,
  ) {}

  // Moves the WF-03 instance (when one exists) and keeps Application.status in step with it.
  private async advance(applicationId: string, event: string, status: string) {
    const wf = await this.workflow.findBySubject(WF03, 'Application', applicationId);
    if (wf && !wf.closed) await this.workflow.fire(wf.id, event);
    await this.prisma.db.application.updateMany({ where: { id: applicationId }, data: { status: status as any } });
  }

  private async loadApp(id: string) {
    const app = await this.prisma.db.application.findFirst({ where: { id }, include: { vacancy: true, candidate: true } });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  // ---------------------------------------------------------------- offers

  async createOffer(applicationId: string, input: OfferInput, user: RequestUser) {
    const app = await this.loadApp(applicationId);
    if (app.status !== 'ADVANCED') throw new ConflictException(`Application is ${app.status}; only advanced candidates get offers`);
    if (await this.prisma.db.offer.findFirst({ where: { applicationId } })) throw new ConflictException('This application already has an offer');
    const [position, branch, entity] = await Promise.all([
      this.prisma.db.jobPosition.findFirstOrThrow({ where: { id: app.vacancy.positionId } }),
      this.prisma.db.branch.findFirstOrThrow({ where: { id: app.vacancy.branchId } }),
      this.prisma.db.legalEntity.findFirstOrThrow({ where: { id: app.vacancy.legalEntityId } }),
    ]);
    const basic = money(input.salaryBasic);
    if (basic.lt(position.payBandMin)) throw new BadRequestException(`Salary is below the pay band minimum (${position.payBandMin} JOD)`);
    const allowances = input.allowances ?? [];
    const monthly = allowances.reduce((s, a) => s.plus(a.amount), basic);
    const annual = monthly.times(12);
    const max = d(position.payBandMax);
    const variancePct = basic.gt(max) ? basic.minus(max).div(max).times(100).toNumber() : 0;
    if (input.contractType === 'FIXED_TERM' && !input.endDate) throw new BadRequestException('endDate is required for fixed-term contracts');

    const decision = await this.policy.evaluate(OFFER_ACTION, { amount: Number(annual), variancePct, branchId: branch.id });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Offers are blocked by policy');
    const status = decision.decision === 'AUTO' ? 'APPROVED' : 'PENDING_APPROVAL';

    const text = buildContract({
      employer: { name: entity.name, taxNumber: entity.taxNumber },
      candidateName: app.candidate.name,
      position: { title: position.title, titleAr: position.titleAr },
      branch: branch.name,
      salaryBasic: basic.toFixed(3),
      allowances,
      startDate: input.startDate.slice(0, 10),
      endDate: input.endDate?.slice(0, 10),
      contractType: input.contractType ?? 'OPEN',
      probationMonths: input.probationMonths ?? 3,
      weeklyHours: String(input.weeklyHours ?? 48),
    });
    const offer = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('OFR', 'OFR', tx);
      const o = await tx.offer.create({
        data: {
          tenantId: '',
          applicationId,
          number,
          positionId: position.id,
          branchId: branch.id,
          startDate: dateOnly(input.startDate),
          contractType: input.contractType ?? 'OPEN',
          endDate: input.endDate ? dateOnly(input.endDate) : null,
          salaryBasic: basic,
          allowances: allowances as any,
          weeklyHours: input.weeklyHours ?? 48,
          probationMonths: input.probationMonths ?? 3,
          status,
          contractText: text as any,
          createdBy: user.id,
        },
      });
      await this.audit.record({ action: 'offer.created', entityType: 'Offer', entityId: o.id, policyVersion: decision.policyVersion, after: { number, status, annual: annual.toString(), variancePct } }, tx);
      return o;
    });
    const doc = await this.docs.upload({ originalname: `${offer.number}-contract.html`, mimetype: 'text/html', buffer: Buffer.from(text.en + '\n' + text.ar), size: 0 }, user, { subjectType: 'Offer', subjectId: offer.id }, { extract: false });
    await this.prisma.db.offer.updateMany({ where: { id: offer.id }, data: { contractDocId: doc.id } });
    if (status === 'PENDING_APPROVAL') {
      await this.approvals.request({ subjectType: 'Offer', subjectId: offer.id, action: OFFER_ACTION, approverRole: decision.approverRole!, amount: Number(annual), branchId: branch.id });
    }
    await this.advance(applicationId, 'offer_created', 'OFFER_PENDING');
    return this.prisma.db.offer.findFirstOrThrow({ where: { id: offer.id } });
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== OFFER_ACTION) return;
    await runWithTenant(e.tenantId, async () => {
      const offer = await this.prisma.db.offer.findFirst({ where: { id: e.subjectId } });
      if (!offer || offer.status !== 'PENDING_APPROVAL') return;
      if (e.approved) {
        await this.prisma.db.offer.updateMany({ where: { id: offer.id }, data: { status: 'APPROVED' } });
        await this.audit.record({ action: 'offer.approved', entityType: 'Offer', entityId: offer.id, after: { by: e.decidedBy } });
      } else {
        await this.prisma.db.offer.updateMany({ where: { id: offer.id }, data: { status: 'WITHDRAWN' } });
        await this.advance(offer.applicationId, 'offer_withdrawn', 'ADVANCED');
      }
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  listOffers(status?: string) {
    return this.prisma.db.offer.findMany({ where: { status: status as any }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async offerForApplication(applicationId: string) {
    const o = await this.prisma.db.offer.findFirst({ where: { applicationId } });
    if (!o) throw new NotFoundException('No offer for this application');
    return o;
  }

  private async offer(id: string) {
    const o = await this.prisma.db.offer.findFirst({ where: { id } });
    if (!o) throw new NotFoundException('Offer not found');
    return o;
  }

  async sendOffer(id: string) {
    const o = await this.offer(id);
    if (o.status !== 'APPROVED') throw new ConflictException(`Offer is ${o.status}; it must be approved before sending`);
    const app = await this.loadApp(o.applicationId);
    await this.prisma.db.offer.updateMany({ where: { id, status: 'APPROVED' }, data: { status: 'SENT' } });
    await this.notifier.send({ phone: app.candidate.phone, email: app.candidate.email, template: 'offer_sent', text: `Your job offer is ready. Review and sign it at /apply/status/${app.trackingToken}`, textAr: `عرض العمل جاهز. راجعه ووقعه عبر /apply/status/${app.trackingToken}` });
    await this.audit.record({ action: 'offer.sent', entityType: 'Offer', entityId: id });
    return this.offer(id);
  }

  async withdrawOffer(id: string) {
    const o = await this.offer(id);
    if (['ACCEPTED', 'DECLINED', 'WITHDRAWN'].includes(o.status)) throw new ConflictException(`Offer is ${o.status}`);
    await this.prisma.db.offer.updateMany({ where: { id }, data: { status: 'WITHDRAWN' } });
    await this.prisma.db.approval.updateMany({ where: { subjectType: 'Offer', subjectId: id, status: 'PENDING' }, data: { status: 'REJECTED', comment: 'Offer withdrawn', decidedAt: new Date() } });
    await this.advance(o.applicationId, 'offer_withdrawn', 'ADVANCED');
    await this.audit.record({ action: 'offer.withdrawn', entityType: 'Offer', entityId: id });
    return this.offer(id);
  }

  // Authorized signatory countersigns after the candidate; separation of duties from whoever drafted the offer.
  async countersign(id: string, user: RequestUser) {
    const o = await this.offer(id);
    if (o.status !== 'ACCEPTED' || !o.candidateSignedAt) throw new ConflictException('The candidate must sign first');
    if (o.countersignedAt) return o;
    if (o.createdBy === user.id) throw new ForbiddenException('The person who drafted the offer cannot countersign it');
    await this.prisma.db.offer.updateMany({ where: { id, countersignedAt: null }, data: { countersignedBy: user.id, countersignedAt: new Date() } });
    await this.audit.record({ action: 'offer.countersigned', entityType: 'Offer', entityId: id, after: { by: user.id } });
    return this.offer(id);
  }

  // ---------------------------------------------------------------- candidate access by token

  async withToken<T>(token: string, fn: (app: Awaited<ReturnType<OnboardingService['loadApp']>>) => Promise<T>): Promise<T> {
    const row = await this.prisma.raw.application.findUnique({ where: { trackingToken: token } });
    if (!row) throw new NotFoundException();
    return runWithTenant(row.tenantId, async () => fn(await this.loadApp(row.id)));
  }

  candidateOffer(token: string) {
    return this.withToken(token, async (app) => {
      const o = await this.prisma.db.offer.findFirst({ where: { applicationId: app.id, status: { in: ['SENT', 'ACCEPTED', 'DECLINED'] } } });
      if (!o) throw new NotFoundException('No offer available');
      return { number: o.number, status: o.status, startDate: o.startDate, salaryBasic: o.salaryBasic.toString(), allowances: o.allowances, contractText: o.contractText, signedAt: o.candidateSignedAt };
    });
  }

  acceptOffer(token: string, input: { signatureName: string; agree: boolean }, fingerprint: string) {
    if (!input.agree) throw new BadRequestException('You must agree to the contract terms to sign');
    return this.withToken(token, async (app) => {
      const o = await this.prisma.db.offer.findFirst({ where: { applicationId: app.id } });
      if (!o || o.status !== 'SENT') throw new ConflictException('There is no offer waiting for your signature');
      const position = await this.prisma.db.jobPosition.findFirstOrThrow({ where: { id: o.positionId } });
      const now = new Date();
      await this.prisma.db.$transaction(async (tx) => {
        const res = await tx.offer.updateMany({ where: { id: o.id, status: 'SENT' }, data: { status: 'ACCEPTED', candidateSignedAt: now, candidateSignature: JSON.stringify({ name: input.signatureName, at: now.toISOString(), fingerprint: createHash('sha256').update(fingerprint).digest('hex') }) } });
        if (res.count !== 1) throw new ConflictException('The offer was already answered');
        for (const type of position.requiredDocuments as string[]) {
          const have = await tx.applicationDocument.findFirst({ where: { applicationId: app.id, type } });
          if (!have) await tx.applicationDocument.create({ data: { tenantId: '', applicationId: app.id, type } });
        }
        await this.audit.record({ action: 'offer.accepted', entityType: 'Offer', entityId: o.id, after: { signedBy: input.signatureName } }, tx);
      });
      await this.advance(app.id, 'offer_accepted', 'ONBOARDING');
      await this.notifications.notify({ roleKey: 'HR', title: `Offer ${o.number} accepted`, body: `${app.candidate.name} signed; countersign and collect documents.` });
      return { status: 'ACCEPTED', requiredDocuments: position.requiredDocuments };
    });
  }

  declineOffer(token: string, reason: string) {
    return this.withToken(token, async (app) => {
      const o = await this.prisma.db.offer.findFirst({ where: { applicationId: app.id } });
      if (!o || o.status !== 'SENT') throw new ConflictException('There is no offer waiting for your answer');
      await this.prisma.db.offer.updateMany({ where: { id: o.id }, data: { status: 'DECLINED' } });
      await this.advance(app.id, 'offer_declined', 'WITHDRAWN');
      await this.audit.record({ action: 'offer.declined', entityType: 'Offer', entityId: o.id, after: { reason } });
      return { status: 'DECLINED' };
    });
  }

  uploadDocument(token: string, type: string, file: { originalname: string; mimetype: string; buffer: Buffer; size: number }) {
    return this.withToken(token, async (app) => {
      const row = await this.prisma.db.applicationDocument.findFirst({ where: { applicationId: app.id, type } });
      if (!row) throw new BadRequestException(`'${type}' is not a required document`);
      if (row.status === 'VERIFIED') throw new ConflictException('This document was already verified');
      const doc = await this.docs.upload(file, { id: 'candidate', tenantId: currentTenantId(), email: '', isSystem: false, roles: [], delegations: [] }, { subjectType: 'Application', subjectId: app.id }, { extract: false });
      await this.prisma.db.applicationDocument.updateMany({ where: { id: row.id }, data: { status: 'RECEIVED', evidenceDocumentId: doc.id, note: null } });
      await this.audit.record({ action: 'application_document.received', entityType: 'ApplicationDocument', entityId: row.id, after: { type } });
      return { type, status: 'RECEIVED' };
    });
  }

  // Personal details are entered once by the candidate and kept encrypted until the employee file is created.
  savePersonalDetails(token: string, details: { nationalId: string; dateOfBirth: string; address: string; iban?: string }) {
    return this.withToken(token, async (app) => {
      const intake = (app.intake as Record<string, unknown>) ?? {};
      if (intake.personalEncrypted) throw new ConflictException('Personal details were already provided');
      if (app.status !== 'ONBOARDING') throw new ConflictException('Personal details are collected after the offer is accepted');
      await this.prisma.db.application.updateMany({ where: { id: app.id }, data: { intake: { ...intake, personalEncrypted: this.crypto.encrypt(details) } as any } });
      await this.audit.record({ action: 'application.personal_details_received', entityType: 'Application', entityId: app.id });
      return { received: true };
    });
  }

  // ---------------------------------------------------------------- HR document verification

  async listDocuments(applicationId: string) {
    await this.loadApp(applicationId);
    return this.prisma.db.applicationDocument.findMany({ where: { applicationId }, orderBy: { type: 'asc' } });
  }

  async verifyDocument(applicationId: string, type: string, input: { approve: boolean; note?: string }, user: RequestUser) {
    const app = await this.loadApp(applicationId);
    const row = await this.prisma.db.applicationDocument.findFirst({ where: { applicationId, type } });
    if (!row) throw new NotFoundException('Document not required for this application');
    if (row.status !== 'RECEIVED') throw new ConflictException(`Document is ${row.status}; the candidate has not uploaded it`);
    if (!input.approve && !input.note) throw new BadRequestException('A note is required when rejecting a document');
    await this.prisma.db.applicationDocument.updateMany({ where: { id: row.id }, data: { status: input.approve ? 'VERIFIED' : 'REJECTED', verifiedBy: user.id, note: input.note ?? null } });
    if (!input.approve) {
      await this.notifier.send({ phone: app.candidate.phone, email: app.candidate.email, template: 'document_rejected', text: `Please upload ${type} again: ${input.note}`, textAr: `يرجى إعادة رفع ${type}.` });
    }
    await this.audit.record({ action: input.approve ? 'application_document.verified' : 'application_document.rejected', entityType: 'ApplicationDocument', entityId: row.id, after: { type, note: input.note } });
    return this.prisma.db.applicationDocument.findFirstOrThrow({ where: { id: row.id } });
  }

  // ---------------------------------------------------------------- completion: one transaction creates the employee file

  async completeOnboarding(applicationId: string, user: RequestUser) {
    const app = await this.loadApp(applicationId);
    const existing = await this.prisma.db.employee.findFirst({ where: { candidateId: app.candidateId, positionId: app.vacancy.positionId } });
    if (existing) return this.employeeView(existing.id);
    if (app.status !== 'ONBOARDING') throw new ConflictException(`Application is ${app.status}`);
    const offer = await this.prisma.db.offer.findFirst({ where: { applicationId } });
    if (!offer || offer.status !== 'ACCEPTED' || !offer.countersignedAt) throw new ConflictException('The offer must be signed by the candidate and countersigned');
    const docs = await this.prisma.db.applicationDocument.findMany({ where: { applicationId } });
    const unverified = docs.filter((x) => x.status !== 'VERIFIED').map((x) => x.type);
    if (unverified.length) throw new ConflictException(`Documents not verified yet: ${unverified.join(', ')}`);
    const personalEnc = (app.intake as Record<string, any>)?.personalEncrypted as string | undefined;
    if (!personalEnc) throw new ConflictException('The candidate has not provided personal details yet');

    const [position, entity, branch] = await Promise.all([
      this.prisma.db.jobPosition.findFirstOrThrow({ where: { id: offer.positionId } }),
      this.prisma.db.legalEntity.findFirstOrThrow({ where: { id: app.vacancy.legalEntityId } }),
      this.prisma.db.branch.findFirstOrThrow({ where: { id: offer.branchId } }),
    ]);
    const startsNow = offer.startDate <= ammanToday();
    const inviteToken = randomBytes(24).toString('hex');
    let invited = false;

    const employeeId = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('EMP', 'EMP', tx);
      const emp = await tx.employee.create({
        data: {
          tenantId: '',
          number,
          legalEntityId: entity.id,
          candidateId: app.candidateId,
          name: app.candidate.name,
          phone: app.candidate.phone,
          email: app.candidate.email,
          status: startsNow ? 'ACTIVE' : 'ONBOARDING',
          hireDate: offer.startDate,
          positionId: position.id,
          sensitive: personalEnc, // already encrypted when the candidate entered it: no re-entry, no plaintext copy
          attendanceProfile: { weeklyHours: Number(offer.weeklyHours), scheduleType: 'ROSTER', clockMethod: 'MANUAL', breakMinutes: 30 },
        },
      });
      await tx.employeeAssignment.create({ data: { tenantId: '', employeeId: emp.id, branchId: branch.id, isPrimary: true, validFrom: offer.startDate } });
      await tx.employmentContract.create({ data: { tenantId: '', employeeId: emp.id, version: 1, type: offer.contractType, startDate: offer.startDate, endDate: offer.endDate, salaryBasic: offer.salaryBasic, allowances: offer.allowances as any, weeklyHours: offer.weeklyHours, probationMonths: offer.probationMonths, documentId: offer.contractDocId, signedAt: offer.candidateSignedAt } });
      for (const m of (position.trainingModules as { title: string; mandatory?: boolean; dueDays?: number }[]) ?? []) {
        await tx.trainingAssignment.create({ data: { tenantId: '', employeeId: emp.id, title: m.title, mandatory: m.mandatory ?? true, dueDate: new Date(offer.startDate.getTime() + (m.dueDays ?? 30) * 86_400_000) } });
      }
      await tx.sscAction.create({ data: { tenantId: '', employeeId: emp.id, kind: 'REGISTRATION', payload: { employeeNumber: number, name: emp.name, hireDate: offer.startDate.toISOString().slice(0, 10), salaryBasic: offer.salaryBasic.toString(), position: position.title, employerTaxNumber: entity.taxNumber } } });

      if (app.candidate.email && !(await tx.user.findFirst({ where: { email: app.candidate.email.toLowerCase() } }))) {
        const role = await tx.role.findFirst({ where: { key: 'EMPLOYEE' } });
        const u = await tx.user.create({ data: { tenantId: '', email: app.candidate.email.toLowerCase(), name: emp.name, passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10) } });
        if (role) await tx.userRole.create({ data: { tenantId: '', userId: u.id, roleId: role.id, branchId: branch.id } });
        await tx.employee.updateMany({ where: { id: emp.id }, data: { userId: u.id } });
        await tx.userInvite.create({ data: { tenantId: '', userId: u.id, tokenHash: createHash('sha256').update(inviteToken).digest('hex'), expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
        invited = true;
      }
      for (const title of [`Add ${emp.name} to the schedule`, 'Prepare uniform and access']) {
        await tx.task.create({ data: { tenantId: '', title, assigneeRole: 'BRANCH_MANAGER', branchId: branch.id } });
      }
      await this.notifications.notify({ roleKey: 'FINANCE', title: `New employee ${number}`, body: `${emp.name} starts ${offer.startDate.toISOString().slice(0, 10)}: set up payroll.` }, tx);
      await this.notifications.notify({ roleKey: 'BRANCH_MANAGER', title: `New team member at ${branch.name}`, body: `${emp.name} (${position.title}) joins on ${offer.startDate.toISOString().slice(0, 10)}.` }, tx);

      const filled = app.vacancy.filled + 1;
      await tx.vacancy.updateMany({ where: { id: app.vacancy.id }, data: { filled: { increment: 1 }, ...(filled >= app.vacancy.headcount ? { status: 'FILLED' as const } : {}) } });
      await this.audit.record({ action: 'employee.created_from_application', entityType: 'Employee', entityId: emp.id, after: { number, applicationId, by: user.id } }, tx);
      return emp.id;
    });

    await this.advance(applicationId, 'onboarding_complete', 'HIRED');
    if (invited) {
      await this.notifier.send({ phone: app.candidate.phone, email: app.candidate.email, template: 'employee_invite', text: `Welcome! Set your password with this one-time code (valid 7 days): ${inviteToken}`, textAr: `مرحبا بك! رمز تعيين كلمة المرور: ${inviteToken}` });
    }
    return this.employeeView(employeeId);
  }

  private async employeeView(id: string) {
    const { sensitive: _s, ...e } = await this.prisma.db.employee.findFirstOrThrow({ where: { id }, include: { assignments: true, contracts: true } });
    return e;
  }
}
