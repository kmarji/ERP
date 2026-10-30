import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { CandidateNotifier } from './candidate-notifier';
import { WF03 } from './recruitment.workflow';

// Shared by screening, interviews, evaluation and decisions: every status change goes through the workflow engine,
// and the application row mirrors the workflow state.
@Injectable()
export class ApplicationFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowEngineService,
    private readonly notifier: CandidateNotifier,
  ) {}

  async load(id: string) {
    const a = await this.prisma.db.application.findFirst({ where: { id }, include: { candidate: true, vacancy: true, interview: true } });
    if (!a) throw new NotFoundException('Application not found');
    return a;
  }

  async fire(appId: string, event: string, patch: { decidedBy?: string; rejectionReason?: string; humanInterviewRequested?: boolean } = {}) {
    const wf = await this.workflow.findBySubject(WF03, 'Application', appId);
    if (!wf) throw new NotFoundException('Application workflow not found');
    const r = await this.workflow.fire(wf.id, event);
    await this.prisma.db.application.updateMany({
      where: { id: appId },
      data: { status: r.state as any, ...(patch.decidedBy ? { decidedBy: patch.decidedBy, decidedAt: new Date() } : {}), ...(patch.rejectionReason ? { rejectionReason: patch.rejectionReason } : {}), ...(patch.humanInterviewRequested !== undefined ? { humanInterviewRequested: patch.humanInterviewRequested } : {}) },
    });
    return r.state;
  }

  async notify(candidate: { phone: string; email: string | null; anonymizedAt: Date | null }, template: string, text: string, textAr: string) {
    if (candidate.anonymizedAt) return;
    await this.notifier.send({ phone: candidate.phone, email: candidate.email, template, text, textAr });
  }
}
