import { Injectable, NotFoundException } from '@nestjs/common';
import { Decimal, d } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.module';
import { PolicyService } from '../policy-engine/policy.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { ApplicationFlowService } from './application-flow.service';
import { detectInjection } from './injection';
import { LlmAdapter } from './llm.adapters';
import { overallScore, recommend, Rubric, TemplateQuestion } from './rubric';

const AUTO_ADVANCE = 'recruitment.auto_advance';

@Injectable()
export class EvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmAdapter,
    private readonly flow: ApplicationFlowService,
    private readonly policy: PolicyService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Assess a completed interview. The outcome is an advisory recommendation with evidence; only a clearly strong,
  // confident, flag-free result may progress by configured policy, everything else goes to a person. Nobody is
  // rejected here.
  async evaluate(interviewId: string) {
    const existing = await this.prisma.db.evaluation.findFirst({ where: { interviewId } });
    if (existing) return existing;
    const interview = await this.prisma.db.interview.findFirst({ where: { id: interviewId } });
    if (!interview) throw new NotFoundException('Interview not found');
    const app = await this.flow.load(interview.applicationId);
    const snap = interview.templateSnapshot as unknown as { questions: TemplateQuestion[]; rubric: Rubric };
    const transcript = (interview.transcript as { role: string; text: string; questionId?: string }[]) ?? [];
    const answers = snap.questions.map((q) => ({ questionId: q.id, text: transcript.filter((m) => m.role === 'CANDIDATE' && m.questionId === q.id).map((m) => m.text).join('\n') }));

    const flags: { code: string; message: string }[] = [];
    let scores: Awaited<ReturnType<LlmAdapter['assess']>>['scores'] = [];
    let confidence = 0;
    let failed = false;
    try {
      const a = await this.llm.assess({ language: interview.language as 'en' | 'ar', questions: snap.questions, rubric: snap.rubric, answers });
      scores = a.scores;
      confidence = a.confidence;
      flags.push(...a.flags);
    } catch (e: any) {
      failed = true;
      flags.push({ code: 'ASSESSOR_FAILED', message: `The automated assessment failed (${e.message}); a person must assess the transcript` });
      scores = snap.questions.map((q) => ({ questionId: q.id, competency: q.competency, score: snap.rubric.scale.min, evidence: [], reasoning: 'Not assessed.' }));
    }
    const injected = answers.flatMap((a) => detectInjection(a.text));
    if (injected.length) flags.push({ code: 'POSSIBLE_PROMPT_INJECTION', message: 'An answer appears to address the assessor rather than the question; scores are not relied on' });
    if (app.humanInterviewRequested) flags.push({ code: 'HUMAN_REQUESTED', message: 'The candidate asked for a human interviewer' });

    const overall = overallScore(scores, snap.rubric);
    const recommendation = recommend(overall, snap.rubric);
    const decision = await this.policy.evaluate(AUTO_ADVANCE, { confidence });
    const autoAdvance = !failed && recommendation === 'ADVANCE' && flags.length === 0 && decision.decision === 'AUTO';

    const evaluation = await this.prisma.db.evaluation.create({
      data: {
        tenantId: '',
        interviewId,
        applicationId: app.id,
        scores: scores as any,
        overall: overall as unknown as Decimal,
        recommendation,
        confidence,
        flags: flags as any,
        humanReviewRequired: !autoAdvance,
        engine: this.llm.name,
        engineVersion: this.llm.version,
        rubricVersion: (await this.prisma.db.interviewTemplate.findFirst({ where: { id: interview.templateId } }))?.version ?? 1,
      },
    });
    await this.audit.record({ action: 'evaluation.created', entityType: 'Evaluation', entityId: evaluation.id, policyVersion: decision.policyVersion, actorType: 'SYSTEM', after: { application: app.id, overall, recommendation, confidence, flags: flags.map((f) => f.code), engine: `${this.llm.name}@${this.llm.version}`, autoAdvance } });

    await this.flow.fire(app.id, 'interview_done');
    if (autoAdvance) {
      await this.flow.fire(app.id, 'auto_advance', { decidedBy: `POLICY:${AUTO_ADVANCE}:v${decision.policyVersion}` });
      await this.notifications.notify({ roleKey: 'HR', title: `Candidate advanced automatically: ${app.candidate.name}`, body: `Score ${overall}/${snap.rubric.scale.max}, confidence ${confidence}. Within delegated policy, no action needed unless you disagree.` });
    } else {
      await this.flow.fire(app.id, 'needs_review');
      await this.exceptions.raise({
        code: 'HR_REVIEW_REQUIRED',
        reason: `Interview assessment for ${app.candidate.name} needs a person: recommendation ${recommendation}, score ${overall}/${snap.rubric.scale.max}, confidence ${confidence}${flags.length ? `, flags: ${flags.map((f) => f.code).join(', ')}` : ''}`,
        evidence: { applicationId: app.id, evaluationId: evaluation.id, recommendation, overall, confidence, flags },
        impact: 'The candidate stays in the pipeline until a person decides; the assessment is advice, not a decision',
        ownerRole: 'HR',
        riskTier: 'MEDIUM',
        availableActions: ['resolve'],
      });
    }
    await this.flow.notify(app.candidate, 'interview_completed', 'Thank you for completing the interview. We will be in touch about the next step.', 'شكراً لإكمالك المقابلة. سنتواصل معك بخصوص الخطوة التالية.');
    return evaluation;
  }
}
