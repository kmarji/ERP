import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.module';
import { NotificationsService } from '../notifications/notifications.module';
import { ExceptionService } from '../workflow-engine/exception.service';
import { ApplicationFlowService } from './application-flow.service';
import { EvaluationService } from './evaluation.service';
import { detectInjection } from './injection';
import { INTERVIEW_NOTICE_VERSION, interviewNotice } from './interview-notice';
import { Rubric, TemplateQuestion } from './rubric';

const WINDOW_DAYS = 7;
const MAX_ANSWER = 2000;

interface Msg {
  role: 'AI' | 'CANDIDATE';
  text: string;
  at: string;
  questionId?: string;
  flags?: string[];
}

@Injectable()
export class InterviewsService {
  private readonly log = new Logger(InterviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flow: ApplicationFlowService,
    private readonly evaluation: EvaluationService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly exceptions: ExceptionService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  retentionMonths() {
    return Number(this.config.get('RECRUITMENT_RETENTION_MONTHS') ?? 6);
  }

  // Creates (or, for an expired/cancelled one, refreshes) the invitation. The template is frozen into the interview so
  // every candidate for a vacancy is asked the same questions and scored by the same rubric.
  async invite(applicationId: string, by: 'POLICY' | string = 'POLICY') {
    const app = await this.flow.load(applicationId);
    const position = await this.prisma.db.jobPosition.findFirst({ where: { id: app.vacancy.positionId } });
    if (!position?.interviewTemplateId) throw new BadRequestException('This position has no interview template');
    const template = await this.prisma.db.interviewTemplate.findFirst({ where: { id: position.interviewTemplateId, active: true } });
    if (!template) throw new BadRequestException('The interview template is inactive');
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + WINDOW_DAYS * 86_400_000);
    const retentionUntil = new Date(Date.now() + this.retentionMonths() * 30 * 86_400_000);
    const snapshot = { questions: template.questions, rubric: template.rubric, name: template.name, version: template.version };
    if (app.interview) {
      if (!['EXPIRED', 'CANCELLED'].includes(app.interview.status)) throw new ConflictException(`An interview already exists (${app.interview.status})`);
      await this.prisma.db.interview.updateMany({ where: { id: app.interview.id }, data: { status: 'INVITED', accessToken: token, expiresAt, templateSnapshot: snapshot as any, templateId: template.id, language: template.language, consent: undefined, consentAt: null, transcript: [], currentQuestion: 0, followUpsUsed: 0, startedAt: null, scheduledFor: null } });
    } else {
      await this.prisma.db.interview.create({ data: { tenantId: '', applicationId, templateId: template.id, templateSnapshot: snapshot as any, language: template.language, accessToken: token, expiresAt, retentionUntil } });
    }
    const event = ['UNDER_REVIEW', 'INTERVIEW_SCHEDULED'].includes(app.status) ? 'reinvite' : 'invite';
    await this.flow.fire(applicationId, event, by === 'POLICY' ? { decidedBy: 'POLICY:recruitment.screening' } : { decidedBy: by });
    await this.audit.record({ action: 'interview.invited', entityType: 'Application', entityId: applicationId, actorType: by === 'POLICY' ? 'SYSTEM' : 'USER', after: { expiresAt, template: template.name } });
    await this.flow.notify(app.candidate, 'interview_invitation', `You are invited to an online interview (${template.name}). Open /apply/interview/${token} within ${WINDOW_DAYS} days. You will first see how your answers are used and can ask for a human interviewer instead.`, `تمت دعوتك إلى مقابلة عبر الإنترنت. افتح /apply/interview/${token} خلال ${WINDOW_DAYS} أيام. ستطلع أولاً على كيفية استخدام إجاباتك ويمكنك طلب مقابلة مع شخص.`);
    return { token, expiresAt };
  }

  private async byToken(token: string) {
    const i = await this.prisma.db.interview.findFirst({ where: { accessToken: token } });
    if (!i) throw new NotFoundException('Interview not found');
    if (['INVITED', 'SCHEDULED'].includes(i.status) && i.expiresAt < new Date()) throw new ForbiddenException('This interview link has expired; ask the recruiter for a new one');
    return i;
  }

  private questions(i: { templateSnapshot: unknown }) {
    return (i.templateSnapshot as { questions: TemplateQuestion[] }).questions;
  }

  async notice(token: string) {
    const i = await this.byToken(token);
    const qs = this.questions(i);
    return {
      status: i.status,
      language: i.language,
      questions: qs.length,
      estimatedMinutes: qs.length * 4,
      expiresAt: i.expiresAt,
      scheduledFor: i.scheduledFor,
      notice: interviewNotice(this.retentionMonths()),
      consentGiven: !!i.consentAt,
      options: { recordingOptional: true, humanInterviewAvailable: true },
    };
  }

  async consent(token: string, input: { processing: boolean; recording?: boolean; noticeVersion: string }, ip: string) {
    const i = await this.byToken(token);
    if (input.noticeVersion !== INTERVIEW_NOTICE_VERSION) throw new BadRequestException('Please read the current notice before consenting');
    if (!input.processing) throw new BadRequestException('The interview cannot proceed without consent to process your answers. You can ask for a human interviewer instead.');
    if (i.consentAt) return { consented: true };
    await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { consent: { noticeVersion: INTERVIEW_NOTICE_VERSION, processing: true, recording: !!input.recording, at: new Date().toISOString(), ipHash: createHash('sha256').update(ip).digest('hex').slice(0, 16) } as any, consentAt: new Date(), status: 'SCHEDULED' } });
    await this.flow.fire(i.applicationId, 'scheduled');
    await this.audit.record({ action: 'interview.consent_given', entityType: 'Interview', entityId: i.id, actorType: 'USER', after: { recording: !!input.recording, noticeVersion: INTERVIEW_NOTICE_VERSION } });
    return { consented: true };
  }

  async schedule(token: string, scheduledFor: string) {
    const i = await this.byToken(token);
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime()) || when < new Date() || when > i.expiresAt) throw new BadRequestException('Choose a time before your invitation expires');
    await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { scheduledFor: when } });
    return { scheduledFor: when };
  }

  async start(token: string) {
    const i = await this.byToken(token);
    if (!i.consentAt) throw new ConflictException('Consent is required before the interview can start');
    if (i.status === 'IN_PROGRESS') return this.current(i);
    if (i.status !== 'SCHEDULED') throw new ConflictException(`Interview is ${i.status}`);
    const qs = this.questions(i);
    const first = qs[0];
    const greeting = i.language === 'ar' ? 'مرحباً، سأطرح عليك عدداً من الأسئلة. يمكنك الإجابة بما يناسبك ولا حاجة للتسرع.' : 'Hello. I will ask you a few questions. Take your time and answer in your own words.';
    const transcript: Msg[] = [{ role: 'AI', text: greeting, at: new Date().toISOString() }, { role: 'AI', text: this.qText(first, i.language), at: new Date().toISOString(), questionId: first.id }];
    await this.prisma.db.interview.updateMany({ where: { id: i.id, status: 'SCHEDULED' }, data: { status: 'IN_PROGRESS', startedAt: new Date(), transcript: transcript as any } });
    return this.current(await this.prisma.db.interview.findFirstOrThrow({ where: { id: i.id } }));
  }

  private qText(q: TemplateQuestion, language: string) {
    return language === 'ar' && q.textAr ? q.textAr : q.text;
  }

  private current(i: { templateSnapshot: unknown; currentQuestion: number; language: string; status: string }) {
    const qs = this.questions(i);
    if (i.status === 'COMPLETED') return { done: true };
    const q = qs[i.currentQuestion];
    return { done: false, index: i.currentQuestion + 1, total: qs.length, questionId: q.id, question: this.qText(q, i.language) };
  }

  // One answer per call. A very short answer may get a bounded follow-up; otherwise the next question follows.
  async answer(token: string, text: string) {
    const i = await this.byToken(token);
    if (i.status !== 'IN_PROGRESS') throw new ConflictException(`Interview is ${i.status}`);
    const clean = text.trim();
    if (!clean || clean.length > MAX_ANSWER) throw new BadRequestException(`Answers must be 1 to ${MAX_ANSWER} characters`);
    const qs = this.questions(i);
    const q = qs[i.currentQuestion];
    const rubric = (i.templateSnapshot as unknown as { rubric: Rubric }).rubric;
    const transcript = (i.transcript as unknown as Msg[]) ?? [];
    const flags = detectInjection(clean);
    transcript.push({ role: 'CANDIDATE', text: clean, at: new Date().toISOString(), questionId: q.id, ...(flags.length ? { flags: ['POSSIBLE_PROMPT_INJECTION'] } : {}) });

    const answerSoFar = transcript.filter((m) => m.role === 'CANDIDATE' && m.questionId === q.id).map((m) => m.text).join(' ');
    const wordCount = answerSoFar.split(/\s+/).filter(Boolean).length;
    const canFollowUp = (rubric.maxFollowUps ?? 0) > i.followUpsUsed;
    if (wordCount < (q.minWords ?? 15) && canFollowUp) {
      transcript.push({ role: 'AI', text: i.language === 'ar' ? 'هل يمكنك إعطاء مثال محدد وتفاصيل أكثر؟' : 'Could you give a specific example with a bit more detail?', at: new Date().toISOString(), questionId: q.id });
      await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { transcript: transcript as any, followUpsUsed: i.followUpsUsed + 1 } });
      return { done: false, followUp: true, index: i.currentQuestion + 1, total: qs.length, questionId: q.id, question: transcript[transcript.length - 1].text };
    }
    const next = i.currentQuestion + 1;
    if (next >= qs.length) {
      transcript.push({ role: 'AI', text: i.language === 'ar' ? 'شكراً لك. انتهت المقابلة.' : 'Thank you. That is the end of the interview.', at: new Date().toISOString() });
      await this.prisma.db.interview.updateMany({ where: { id: i.id, status: 'IN_PROGRESS' }, data: { transcript: transcript as any, status: 'COMPLETED', completedAt: new Date(), currentQuestion: next } });
      await this.evaluation.evaluate(i.id);
      return { done: true };
    }
    transcript.push({ role: 'AI', text: this.qText(qs[next], i.language), at: new Date().toISOString(), questionId: qs[next].id });
    await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { transcript: transcript as any, currentQuestion: next } });
    return { done: false, index: next + 1, total: qs.length, questionId: qs[next].id, question: transcript[transcript.length - 1].text };
  }

  async uploadRecording(token: string, file: { originalname: string; mimetype: string; buffer: Buffer; size: number }) {
    const i = await this.byToken(token);
    if (!(i.consent as { recording?: boolean } | null)?.recording) throw new ForbiddenException('Recording was not consented to');
    if (!file.mimetype.startsWith('audio/')) throw new BadRequestException('Only audio files are accepted');
    const doc = await this.docs.upload(file, { id: 'candidate', tenantId: i.tenantId, email: '', isSystem: true, roles: [], delegations: [] }, { subjectType: 'Interview', subjectId: i.id }, { extract: false });
    await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { recordingDocId: doc.id } });
    return { stored: true };
  }

  // The candidate may always ask for a person instead of the automated assistant.
  async requestHuman(token: string) {
    const i = await this.byToken(token);
    if (['COMPLETED', 'CANCELLED'].includes(i.status)) throw new ConflictException(`Interview is ${i.status}`);
    const app = await this.flow.load(i.applicationId);
    await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { status: 'CANCELLED' } });
    await this.flow.fire(i.applicationId, 'needs_review', { humanInterviewRequested: true });
    await this.exceptions.raise({ code: 'HR_HUMAN_INTERVIEW_REQUESTED', reason: `${app.candidate.name} asked for a human interviewer for ${app.vacancy.number}`, evidence: { applicationId: i.applicationId }, impact: 'Arrange a live interview, then record the outcome on the application', ownerRole: 'HR', riskTier: 'LOW', availableActions: ['resolve'] });
    await this.audit.record({ action: 'interview.human_requested', entityType: 'Interview', entityId: i.id, actorType: 'USER' });
    await this.flow.notify(app.candidate, 'human_interview', 'We have noted your request. A recruiter will contact you to arrange an interview with a person.', 'سجّلنا طلبك. سيتواصل معك موظف التوظيف لترتيب مقابلة مع شخص.');
    return { requested: true };
  }

  // Staff access to a transcript is always audited.
  async transcriptFor(interviewId: string, viewerId: string) {
    const i = await this.prisma.db.interview.findFirst({ where: { id: interviewId } });
    if (!i) throw new NotFoundException('Interview not found');
    await this.audit.record({ action: 'interview.transcript_viewed', entityType: 'Interview', entityId: i.id, actorId: viewerId, actorType: 'USER' });
    return { id: i.id, status: i.status, language: i.language, consent: i.consent, transcript: i.transcript, recordingDocId: i.recordingDocId };
  }

  // Invitations nobody used are closed gently: the candidate is not penalised, a recruiter decides what happens next.
  @Cron('0 * * * *')
  async expireSweep() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.expireOverdue()).catch((e) => this.log.error(`interview expiry failed for ${t.id}: ${e.message}`));
  }

  async expireOverdue() {
    const overdue = await this.prisma.db.interview.findMany({ where: { status: { in: ['INVITED', 'SCHEDULED'] }, expiresAt: { lt: new Date() } } });
    for (const i of overdue) {
      await this.prisma.db.interview.updateMany({ where: { id: i.id }, data: { status: 'EXPIRED' } });
      await this.flow.fire(i.applicationId, 'needs_review');
      const app = await this.flow.load(i.applicationId);
      await this.exceptions.raise({ code: 'HR_INTERVIEW_EXPIRED', reason: `The interview invitation for ${app.candidate.name} expired unused`, evidence: { applicationId: i.applicationId }, impact: 'Re-invite or close the application', ownerRole: 'HR', riskTier: 'LOW', availableActions: ['resolve'] });
    }
    return overdue.length;
  }
}
