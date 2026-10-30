import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { ApplicationFlowService } from './application-flow.service';
import { InterviewsService } from './interviews.service';
import { INTERVIEW_NOTICE_VERSION } from './interview-notice';
import { WF03 } from './recruitment.workflow';
import { RetentionService } from './retention.service';
import { Criterion, Intake, missingFields, screen } from './screening';

export const REJECTION_REASONS: Record<string, { en: string; ar: string }> = {
  NOT_MEETING_REQUIREMENTS: { en: 'The role requires skills or availability that your application did not show.', ar: 'تتطلب الوظيفة مهارات أو توفراً لم يظهر في طلبك.' },
  INTERVIEW_ASSESSMENT: { en: 'After reviewing your interview, we are moving forward with other candidates.', ar: 'بعد مراجعة مقابلتك، سنتابع مع مرشحين آخرين.' },
  NO_SHOW: { en: 'We could not complete the interview with you.', ar: 'لم نتمكن من إكمال المقابلة معك.' },
  POSITION_FILLED: { en: 'The position has been filled.', ar: 'تم شغل الوظيفة.' },
  OTHER_JOB_RELATED: { en: 'Another candidate was a closer match for the role.', ar: 'كان مرشح آخر أقرب إلى متطلبات الوظيفة.' },
};

const STAGE: Record<string, { en: string; ar: string }> = {
  RECEIVED: { en: 'Application received', ar: 'تم استلام الطلب' },
  INCOMPLETE: { en: 'More information needed', ar: 'مطلوب معلومات إضافية' },
  SCREENED_OUT: { en: 'Under review', ar: 'قيد المراجعة' },
  SCREENED: { en: 'Under review', ar: 'قيد المراجعة' },
  INTERVIEW_INVITED: { en: 'Interview invitation', ar: 'دعوة لمقابلة' },
  INTERVIEW_SCHEDULED: { en: 'Interview scheduled', ar: 'تم تحديد المقابلة' },
  INTERVIEWED: { en: 'Under review', ar: 'قيد المراجعة' },
  UNDER_REVIEW: { en: 'Under review', ar: 'قيد المراجعة' },
  ADVANCED: { en: 'Shortlisted', ar: 'ضمن القائمة المختصرة' },
  OFFER_PENDING: { en: 'Offer', ar: 'عرض وظيفي' },
  ONBOARDING: { en: 'Onboarding', ar: 'إجراءات التعيين' },
  HIRED: { en: 'Hired', ar: 'تم التعيين' },
  REJECTED: { en: 'Not selected', ar: 'لم يتم اختيارك' },
  WITHDRAWN: { en: 'Withdrawn', ar: 'تم السحب' },
};

const APPEAL_WINDOW_DAYS = 30;
export const RECRUIT_ROLES = ['OWNER', 'HR', 'BRANCH_MANAGER'] as const;

export interface ApplyInput {
  name: string;
  phone: string;
  email?: string;
  consent: boolean;
  intake: Intake;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flow: ApplicationFlowService,
    private readonly workflow: WorkflowEngineService,
    private readonly interviews: InterviewsService,
    private readonly retention: RetentionService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- public: apply and track

  async apply(code: string, input: ApplyInput) {
    if (!input.consent) throw new BadRequestException('Consent to process your application data is required');
    const vacancy = await this.prisma.db.vacancy.findFirst({ where: { publicCode: code } });
    if (!vacancy || vacancy.status !== 'OPEN' || (vacancy.closesAt && vacancy.closesAt < new Date())) throw new NotFoundException('This vacancy is not open');
    const months = Number(process.env.RECRUITMENT_RETENTION_MONTHS ?? 6);
    let candidate = await this.prisma.db.candidate.findFirst({ where: { phone: input.phone } });
    if (!candidate) {
      candidate = await this.prisma.db.candidate.create({ data: { tenantId: '', name: input.name, phone: input.phone, email: input.email ?? null, dataConsentAt: new Date(), privacyNoticeVersion: INTERVIEW_NOTICE_VERSION, retentionUntil: new Date(Date.now() + months * 30 * 86_400_000) } });
    } else if (await this.prisma.db.application.findFirst({ where: { vacancyId: vacancy.id, candidateId: candidate.id } })) {
      throw new ConflictException('You have already applied for this vacancy. Use the status link you were given.');
    }
    const app = await this.prisma.db.application.create({ data: { tenantId: '', vacancyId: vacancy.id, candidateId: candidate.id, intake: input.intake as any, trackingToken: randomBytes(24).toString('hex') } });
    await this.workflow.start(WF03, 'Application', app.id, 'MEDIUM');
    await this.audit.record({ action: 'application.received', entityType: 'Application', entityId: app.id, actorType: 'USER', after: { vacancy: vacancy.number } });
    await this.flow.notify(candidate, 'application_received', `We received your application. Track it at /apply/status/${app.trackingToken}`, `استلمنا طلبك. يمكنك متابعته عبر /apply/status/${app.trackingToken}`);
    await this.runScreening(app.id);
    const fresh = await this.prisma.db.application.findFirstOrThrow({ where: { id: app.id } });
    return { trackingToken: app.trackingToken, status: fresh.status, stage: STAGE[fresh.status], missing: fresh.missing };
  }

  // Completeness first, then the objective criteria. Passing candidates progress by configured rules; failing ones are
  // only marked for a recruiter to confirm, never rejected automatically.
  async runScreening(appId: string) {
    const app = await this.flow.load(appId);
    if (app.status !== 'RECEIVED') return app.status;
    const intake = app.intake as Intake;
    const missing = missingFields(intake, app.vacancy.requiredSkills as string[]);
    if (missing.length) {
      await this.prisma.db.application.updateMany({ where: { id: appId }, data: { missing: missing as any } });
      await this.flow.fire(appId, 'incomplete');
      await this.flow.notify(app.candidate, 'application_incomplete', `Your application needs a little more information: ${missing.join(', ')}. Update it at /apply/status/${app.trackingToken}`, 'يحتاج طلبك إلى معلومات إضافية. يمكنك تحديثه من صفحة حالة الطلب.');
      return 'INCOMPLETE';
    }
    const result = screen(app.vacancy.criteria as unknown as Criterion[], intake);
    await this.prisma.db.application.updateMany({ where: { id: appId }, data: { missing: [], eligibility: result.results as any } });
    if (!result.pass) {
      await this.flow.fire(appId, 'screen_fail');
      await this.exceptions.raise({
        code: 'HR_SCREEN_REVIEW',
        reason: `${app.candidate.name} did not meet ${result.results.filter((r) => !r.pass).length} screening criterion(s) for ${app.vacancy.number}: ${result.results.filter((r) => !r.pass).map((r) => r.detail).join('; ')}`,
        evidence: { applicationId: appId, results: result.results },
        impact: 'Nobody is rejected automatically: confirm the screening result or override it',
        ownerRole: 'HR',
        riskTier: 'LOW',
        availableActions: ['resolve'],
      });
      return 'SCREENED_OUT';
    }
    await this.flow.fire(appId, 'screen_pass', { decidedBy: 'POLICY:recruitment.screening' });
    const position = await this.prisma.db.jobPosition.findFirst({ where: { id: app.vacancy.positionId } });
    if (position?.interviewTemplateId) await this.interviews.invite(appId);
    return 'SCREENED';
  }

  async statusView(token: string) {
    const app = await this.prisma.db.application.findFirst({ where: { trackingToken: token }, include: { candidate: true, vacancy: true, interview: true, appeals: true } });
    if (!app) throw new NotFoundException('Application not found');
    const [position, branch, offer, documents] = await Promise.all([
      this.prisma.db.jobPosition.findFirst({ where: { id: app.vacancy.positionId } }),
      this.prisma.db.branch.findFirst({ where: { id: app.vacancy.branchId } }),
      this.prisma.db.offer.findFirst({ where: { applicationId: app.id } }),
      this.prisma.db.applicationDocument.findMany({ where: { applicationId: app.id } }),
    ]);
    const live = app.interview && ['INVITED', 'SCHEDULED', 'IN_PROGRESS'].includes(app.interview.status);
    const appealableUntil = app.status === 'REJECTED' && app.decidedAt ? new Date(app.decidedAt.getTime() + APPEAL_WINDOW_DAYS * 86_400_000) : null;
    return {
      vacancy: { title: position?.title, titleAr: position?.titleAr, branch: branch?.name },
      status: app.status,
      stage: STAGE[app.status],
      anonymized: !!app.candidate.anonymizedAt,
      missing: app.missing,
      interview: live ? { status: app.interview!.status, path: `/apply/interview/${app.interview!.accessToken}`, expiresAt: app.interview!.expiresAt, scheduledFor: app.interview!.scheduledFor } : null,
      offer: offer && ['SENT', 'ACCEPTED', 'DECLINED'].includes(offer.status) ? { status: offer.status, startDate: offer.startDate } : null,
      documents: documents.map((d) => ({ type: d.type, status: d.status, note: d.status === 'REJECTED' ? d.note : null })),
      rejection: app.status === 'REJECTED' ? { reason: REJECTION_REASONS[app.rejectionReason ?? '']?.en ?? null, reasonAr: REJECTION_REASONS[app.rejectionReason ?? '']?.ar ?? null, appealOpen: app.appeals.some((a) => a.status === 'OPEN'), appealableUntil } : null,
      rights: { withdraw: !['HIRED', 'WITHDRAWN'].includes(app.status), erase: !['ONBOARDING', 'OFFER_PENDING', 'HIRED'].includes(app.status), humanInterview: !!live },
    };
  }

  private async byToken(token: string) {
    const app = await this.prisma.db.application.findFirst({ where: { trackingToken: token } });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  async updateIntake(token: string, patch: Intake) {
    const app = await this.byToken(token);
    if (!['INCOMPLETE', 'RECEIVED'].includes(app.status)) throw new ConflictException('This application can no longer be edited; contact the recruiter');
    await this.prisma.db.application.updateMany({ where: { id: app.id }, data: { intake: { ...(app.intake as object), ...patch } as any } });
    if (app.status === 'INCOMPLETE') await this.flow.fire(app.id, 'completed');
    await this.audit.record({ action: 'application.intake_updated', entityType: 'Application', entityId: app.id, actorType: 'USER' });
    await this.runScreening(app.id);
    return this.statusView(token);
  }

  async withdraw(token: string) {
    const app = await this.byToken(token);
    if (['HIRED', 'WITHDRAWN'].includes(app.status)) throw new ConflictException(`Application is ${app.status}`);
    await this.flow.fire(app.id, 'withdraw');
    await this.prisma.db.interview.updateMany({ where: { applicationId: app.id, status: { in: ['INVITED', 'SCHEDULED', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
    await this.audit.record({ action: 'application.withdrawn', entityType: 'Application', entityId: app.id, actorType: 'USER' });
    return this.statusView(token);
  }

  async erase(token: string) {
    const app = await this.byToken(token);
    const res = await this.retention.anonymize(app.candidateId, 'ERASURE_REQUEST');
    return { erased: true, ...res };
  }

  async openAppeal(token: string, reason: string) {
    const app = await this.prisma.db.application.findFirst({ where: { trackingToken: token }, include: { candidate: true, vacancy: true, appeals: true } });
    if (!app) throw new NotFoundException('Application not found');
    if (app.status !== 'REJECTED') throw new ConflictException('Only a rejection can be appealed');
    if (app.decidedAt && app.decidedAt.getTime() + APPEAL_WINDOW_DAYS * 86_400_000 < Date.now()) throw new ConflictException(`The ${APPEAL_WINDOW_DAYS}-day appeal window has passed`);
    if (app.appeals.some((a) => a.status === 'OPEN')) throw new ConflictException('An appeal is already open');
    const appeal = await this.prisma.db.appeal.create({ data: { tenantId: '', applicationId: app.id, reason, originalDecidedBy: app.decidedBy } });
    await this.exceptions.raise({ code: 'RECRUITMENT_APPEAL', reason: `${app.candidate.name} appealed the rejection for ${app.vacancy.number}: ${reason.slice(0, 120)}`, evidence: { applicationId: app.id, appealId: appeal.id }, impact: 'Someone other than the original decider must review it', ownerRole: 'HR', riskTier: 'MEDIUM', availableActions: ['resolve'] });
    await this.audit.record({ action: 'appeal.opened', entityType: 'Appeal', entityId: appeal.id, actorType: 'USER' });
    await this.flow.notify(app.candidate, 'appeal_received', 'We received your appeal. A different reviewer will look at your application and reply.', 'استلمنا اعتراضك. سيراجع طلبك موظف آخر وسنرد عليك.');
    return { appealId: appeal.id, status: 'OPEN' };
  }

  // ---------------------------------------------------------------- staff

  private async visible(id: string, user: RequestUser) {
    const app = await this.flow.load(id);
    assertBranchAccess(user, app.vacancy.branchId, RECRUIT_ROLES);
    return app;
  }

  async list(filter: { vacancyId?: string; status?: string }, user: RequestUser) {
    const rows = await this.prisma.db.application.findMany({ where: { vacancyId: filter.vacancyId, status: filter.status as any }, include: { candidate: { select: { name: true, anonymizedAt: true } }, vacancy: { select: { number: true, branchId: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.filter((r) => { try { assertBranchAccess(user, r.vacancy.branchId, RECRUIT_ROLES); return true; } catch { return false; } }).map((r) => ({ id: r.id, status: r.status, candidate: r.candidate.name, vacancy: r.vacancy.number, createdAt: r.createdAt, decidedBy: r.decidedBy }));
  }

  // Viewing a candidate's file is itself audited.
  async get(id: string, user: RequestUser) {
    const app = await this.visible(id, user);
    const evaluation = await this.prisma.db.evaluation.findFirst({ where: { applicationId: id } });
    await this.audit.record({ action: 'candidate.viewed', entityType: 'Application', entityId: id, actorId: user.id, actorType: 'USER' });
    const { interview, candidate, vacancy, ...rest } = app;
    return { ...rest, trackingToken: undefined, candidate: { id: candidate.id, name: candidate.name, phone: candidate.phone, email: candidate.email, retentionUntil: candidate.retentionUntil, anonymizedAt: candidate.anonymizedAt }, vacancy: { id: vacancy.id, number: vacancy.number, branchId: vacancy.branchId }, interview: interview ? { id: interview.id, status: interview.status, consentAt: interview.consentAt, completedAt: interview.completedAt, language: interview.language } : null, evaluation };
  }

  // Every rejection and advancement here is a person's decision, recorded with who and why.
  async decide(id: string, input: { action: 'advance' | 'reject' | 'invite' | 'reinvite' | 'confirm_screening_reject' | 'override_screening'; reason?: string; note?: string }, user: RequestUser) {
    const app = await this.visible(id, user);
    const by = user.id;
    const needReason = () => {
      if (!input.reason || !REJECTION_REASONS[input.reason]) throw new BadRequestException(`A job-related reason is required: ${Object.keys(REJECTION_REASONS).join(', ')}`);
      return input.reason;
    };
    const reject = async (event: string) => {
      const reason = needReason();
      await this.flow.fire(id, event, { decidedBy: by, rejectionReason: reason });
      await this.flow.notify(app.candidate, 'application_rejected', `Thank you for applying. ${REJECTION_REASONS[reason].en} If you disagree you can appeal from /apply/status/${app.trackingToken}.`, REJECTION_REASONS[reason].ar);
    };
    switch (app.status) {
      case 'SCREENED_OUT':
        if (input.action === 'confirm_screening_reject') {
          input.reason ??= 'NOT_MEETING_REQUIREMENTS';
          await reject('confirm_reject');
        } else if (input.action === 'override_screening') {
          await this.flow.fire(id, 'override', { decidedBy: by });
          const position = await this.prisma.db.jobPosition.findFirst({ where: { id: app.vacancy.positionId } });
          if (position?.interviewTemplateId) await this.interviews.invite(id, by);
        } else throw new BadRequestException(`Allowed here: confirm_screening_reject, override_screening`);
        break;
      case 'SCREENED':
        if (input.action === 'invite') await this.interviews.invite(id, by);
        else if (input.action === 'reject') await reject('reject');
        else throw new BadRequestException('Allowed here: invite, reject');
        break;
      case 'UNDER_REVIEW':
      case 'ADVANCED':
        if (input.action === 'advance' && app.status === 'UNDER_REVIEW') await this.flow.fire(id, 'advance', { decidedBy: by });
        else if (input.action === 'reject') await reject('reject');
        else if (input.action === 'reinvite' && app.status === 'UNDER_REVIEW') await this.interviews.invite(id, by);
        else throw new BadRequestException(`Allowed here: ${app.status === 'UNDER_REVIEW' ? 'advance, reject, reinvite' : 'reject'}`);
        // The assessment is reviewed by a person: record who and what they decided on it.
        await this.prisma.db.evaluation.updateMany({ where: { applicationId: id, reviewedBy: null }, data: { reviewedBy: by, reviewedAt: new Date(), reviewDecision: input.action.toUpperCase(), reviewNotes: input.note ?? null } });
        break;
      default:
        throw new ConflictException(`No decision is possible while the application is ${app.status}`);
    }
    await this.audit.record({ action: `application.${input.action}`, entityType: 'Application', entityId: id, actorId: by, actorType: 'USER', after: { reason: input.reason, note: input.note } });
    return this.get(id, user);
  }

  async transcript(interviewId: string, user: RequestUser) {
    const i = await this.prisma.db.interview.findFirst({ where: { id: interviewId } });
    if (!i) throw new NotFoundException('Interview not found');
    await this.visible(i.applicationId, user);
    return this.interviews.transcriptFor(interviewId, user.id);
  }

  listAppeals(status?: string) {
    return this.prisma.db.appeal.findMany({ where: { status: status as any }, orderBy: { openedAt: 'desc' }, take: 100 });
  }

  async resolveAppeal(id: string, input: { outcome: 'UPHELD' | 'OVERTURNED'; resolution: string }, user: RequestUser) {
    const appeal = await this.prisma.db.appeal.findFirst({ where: { id } });
    if (!appeal) throw new NotFoundException('Appeal not found');
    if (appeal.status !== 'OPEN') throw new ConflictException(`Appeal is ${appeal.status}`);
    // A different person reviews: the original decider cannot mark their own homework.
    if (appeal.originalDecidedBy && appeal.originalDecidedBy === user.id) throw new ForbiddenException('The person who made the original decision cannot resolve the appeal');
    const app = await this.flow.load(appeal.applicationId);
    await this.prisma.db.appeal.updateMany({ where: { id }, data: { status: input.outcome, resolvedBy: user.id, resolvedAt: new Date(), resolution: input.resolution } });
    if (input.outcome === 'OVERTURNED') {
      await this.flow.fire(appeal.applicationId, 'reopen');
      await this.prisma.db.application.updateMany({ where: { id: appeal.applicationId }, data: { rejectionReason: null } });
      await this.flow.notify(app.candidate, 'appeal_overturned', 'Your appeal was successful. Your application is back under review.', 'تم قبول اعتراضك وعاد طلبك قيد المراجعة.');
    } else {
      await this.flow.notify(app.candidate, 'appeal_upheld', 'We reviewed your appeal and the decision stands. Thank you for your interest.', 'راجعنا اعتراضك وبقي القرار كما هو. نشكر اهتمامك.');
    }
    await this.audit.record({ action: `appeal.${input.outcome.toLowerCase()}`, entityType: 'Appeal', entityId: id, actorId: user.id, actorType: 'USER', after: input });
    return this.prisma.db.appeal.findFirstOrThrow({ where: { id } });
  }
}

