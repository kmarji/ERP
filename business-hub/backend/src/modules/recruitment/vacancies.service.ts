import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentContext, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';

export const VACANCY_ROLES = ['OWNER', 'HR', 'BRANCH_MANAGER'] as const;
const VACANCY_ACTION = 'vacancy.approve';

@Injectable()
export class VacanciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // A manager asks for people; policy checks the headcount budget and the cost before the role is advertised.
  async create(input: { branchId: string; positionId: string; headcount: number; payMin?: number; payMax?: number; notes?: string; closesAt?: string; language?: 'en' | 'ar' }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, VACANCY_ROLES);
    const [branch, position] = await Promise.all([this.prisma.db.branch.findFirst({ where: { id: input.branchId, active: true } }), this.prisma.db.jobPosition.findFirst({ where: { id: input.positionId, active: true } })]);
    if (!branch) throw new BadRequestException('Unknown or inactive branch');
    if (!position) throw new BadRequestException('Unknown or inactive position');
    const payMin = input.payMin ?? Number(position.payBandMin);
    const payMax = input.payMax ?? Number(position.payBandMax);
    if (payMin < Number(position.payBandMin) || payMax > Number(position.payBandMax) || payMax < payMin) throw new BadRequestException(`Pay must stay within the position's band (${position.payBandMin} to ${position.payBandMax} JOD)`);

    // Headcount: people in the role at the branch plus roles already being filled, against the approved budget.
    const budget = await this.prisma.db.headcountBudget.findFirst({ where: { branchId: input.branchId, positionId: input.positionId } });
    let overBudget = false;
    let committed = 0;
    if (budget) {
      const employees = await this.prisma.db.employee.count({ where: { positionId: input.positionId, status: { in: ['ONBOARDING', 'ACTIVE', 'ON_LEAVE'] }, assignments: { some: { branchId: input.branchId, isPrimary: true, validTo: null } } } });
      const open = await this.prisma.db.vacancy.findMany({ where: { branchId: input.branchId, positionId: input.positionId, status: { in: ['OPEN', 'PENDING_APPROVAL'] } } });
      committed = employees + open.reduce((s, v) => s + (v.headcount - v.filled), 0);
      overBudget = committed + input.headcount > budget.approved;
    }
    const annualCost = money(d(payMax).times(12).times(input.headcount));
    const decision = overBudget
      ? await this.policy.evaluate('vacancy.over_budget', { amount: Number(annualCost), branchId: input.branchId })
      : await this.policy.evaluate(VACANCY_ACTION, { amount: Number(annualCost), branchId: input.branchId });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Vacancies are blocked by policy');
    const opens = decision.decision === 'AUTO' && !overBudget;

    const vacancy = await this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('VAC', 'VAC', tx);
      const v = await tx.vacancy.create({
        data: {
          tenantId: '',
          number,
          branchId: input.branchId,
          legalEntityId: branch.legalEntityId,
          positionId: input.positionId,
          headcount: input.headcount,
          payMin,
          payMax,
          requiredSkills: position.requiredSkills as any,
          criteria: position.eligibilityCriteria as any,
          status: opens ? 'OPEN' : 'PENDING_APPROVAL',
          publicCode: randomBytes(6).toString('base64url'),
          language: input.language ?? 'en',
          notes: input.notes ?? null,
          requestedBy: user.id,
          closesAt: input.closesAt ? new Date(input.closesAt) : null,
        },
      });
      await this.audit.record({ action: opens ? 'vacancy.opened' : 'vacancy.requested', entityType: 'Vacancy', entityId: v.id, after: { number, headcount: input.headcount, annualCost: annualCost.toString(), overBudget, committed, budget: budget?.approved } }, tx);
      return v;
    });
    if (!opens) {
      await this.approvals.request({ subjectType: 'Vacancy', subjectId: vacancy.id, action: VACANCY_ACTION, approverRole: decision.approverRole ?? 'FINANCE', amount: Number(annualCost), branchId: input.branchId });
    }
    return { ...vacancy, applyPath: `/careers/:tenant/${vacancy.publicCode}`, overBudget };
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== VACANCY_ACTION) return;
    await runWithTenant(e.tenantId, async () => {
      await this.prisma.db.vacancy.updateMany({ where: { id: e.subjectId, status: 'PENDING_APPROVAL' }, data: { status: e.approved ? 'OPEN' : 'CANCELLED' } });
      await this.audit.record({ action: e.approved ? 'vacancy.opened' : 'vacancy.rejected', entityType: 'Vacancy', entityId: e.subjectId, after: { by: e.decidedBy } });
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  list(filter: { branchId?: string; status?: string }) {
    return this.prisma.db.vacancy.findMany({ where: { branchId: filter.branchId, status: filter.status as any }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async get(id: string, user: RequestUser) {
    const v = await this.prisma.db.vacancy.findFirst({ where: { id }, include: { applications: { select: { status: true } } } });
    if (!v) throw new NotFoundException('Vacancy not found');
    assertBranchAccess(user, v.branchId, VACANCY_ROLES);
    const { applications, ...rest } = v;
    const pipeline: Record<string, number> = {};
    for (const a of applications) pipeline[a.status] = (pipeline[a.status] ?? 0) + 1;
    return { ...rest, pipeline };
  }

  async close(id: string, user: RequestUser, to: 'CLOSED' | 'CANCELLED' = 'CLOSED') {
    const v = await this.prisma.db.vacancy.findFirst({ where: { id } });
    if (!v) throw new NotFoundException('Vacancy not found');
    assertBranchAccess(user, v.branchId, VACANCY_ROLES);
    if (['FILLED', 'CLOSED', 'CANCELLED'].includes(v.status)) throw new ConflictException(`Vacancy is ${v.status}`);
    await this.prisma.db.vacancy.updateMany({ where: { id }, data: { status: to } });
    await this.audit.record({ action: `vacancy.${to.toLowerCase()}`, entityType: 'Vacancy', entityId: id, after: { by: user.id } });
    return this.prisma.db.vacancy.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- public

  async publicList() {
    const rows = await this.prisma.db.vacancy.findMany({ where: { status: 'OPEN', OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } });
    const [branches, positions] = await Promise.all([this.prisma.db.branch.findMany({ where: { id: { in: rows.map((r) => r.branchId) } } }), this.prisma.db.jobPosition.findMany({ where: { id: { in: rows.map((r) => r.positionId) } } })]);
    return rows.map((v) => this.publicView(v, branches.find((b) => b.id === v.branchId)?.name, positions.find((p) => p.id === v.positionId)));
  }

  async publicGet(code: string) {
    const v = await this.prisma.db.vacancy.findFirst({ where: { publicCode: code } });
    if (!v || v.status !== 'OPEN' || (v.closesAt && v.closesAt < new Date())) throw new NotFoundException('This vacancy is not open');
    const [branch, position] = await Promise.all([this.prisma.db.branch.findFirst({ where: { id: v.branchId } }), this.prisma.db.jobPosition.findFirst({ where: { id: v.positionId } })]);
    return this.publicView(v, branch?.name, position);
  }

  private publicView(v: { publicCode: string; language: string; closesAt: Date | null; requiredSkills: unknown; criteria: unknown }, branchName?: string, position?: { title: string; titleAr: string | null } | null) {
    return {
      code: v.publicCode,
      title: position?.title,
      titleAr: position?.titleAr,
      branch: branchName,
      language: v.language,
      closesAt: v.closesAt,
      requiredSkills: v.requiredSkills,
      // Candidates see exactly what is checked, so screening is transparent.
      screeningCriteria: (v.criteria as { type: string; value?: unknown; label?: string }[]).map((c) => ({ type: c.type, value: c.value, label: c.label })),
    };
  }
}
