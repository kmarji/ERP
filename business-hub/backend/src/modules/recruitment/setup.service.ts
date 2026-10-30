import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { defaultTemplate } from './default-template';
import { validateTemplate } from './rubric';
import { validateCriteria } from './screening';

export interface PositionInput {
  title: string;
  titleAr?: string;
  payBandMin: number;
  payBandMax: number;
  requiredSkills?: string[];
  eligibilityCriteria?: unknown[];
  interviewTemplateId?: string;
  requiredDocuments?: string[];
  trainingModules?: { title: string; mandatory?: boolean; dueDays?: number }[];
}

@Injectable()
export class RecruitmentSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private checkPosition(i: Partial<PositionInput>) {
    if (i.payBandMin !== undefined && i.payBandMax !== undefined && i.payBandMax < i.payBandMin) throw new BadRequestException('payBandMax is below payBandMin');
    if (i.eligibilityCriteria !== undefined) {
      const v = validateCriteria(i.eligibilityCriteria);
      if (!v.ok) throw new BadRequestException(v.error);
    }
  }

  listPositions() {
    return this.prisma.db.jobPosition.findMany({ orderBy: { title: 'asc' } });
  }

  async createPosition(input: PositionInput) {
    this.checkPosition(input);
    if (input.interviewTemplateId && !(await this.prisma.db.interviewTemplate.findFirst({ where: { id: input.interviewTemplateId } }))) throw new BadRequestException('Unknown interview template');
    const row = await this.prisma.db.jobPosition.create({ data: { tenantId: '', title: input.title, titleAr: input.titleAr ?? null, payBandMin: input.payBandMin, payBandMax: input.payBandMax, requiredSkills: (input.requiredSkills ?? []) as any, eligibilityCriteria: (input.eligibilityCriteria ?? []) as any, interviewTemplateId: input.interviewTemplateId ?? null, ...(input.requiredDocuments ? { requiredDocuments: input.requiredDocuments as any } : {}), trainingModules: (input.trainingModules ?? []) as any } });
    await this.audit.record({ action: 'position.created', entityType: 'JobPosition', entityId: row.id, after: row });
    return row;
  }

  async patchPosition(id: string, input: Partial<PositionInput> & { active?: boolean }) {
    const before = await this.prisma.db.jobPosition.findFirst({ where: { id } });
    if (!before) throw new NotFoundException('Position not found');
    this.checkPosition({ payBandMin: Number(before.payBandMin), payBandMax: Number(before.payBandMax), ...input });
    const { eligibilityCriteria, requiredSkills, requiredDocuments, trainingModules, ...rest } = input;
    await this.prisma.db.jobPosition.updateMany({ where: { id }, data: { ...rest, ...(eligibilityCriteria ? { eligibilityCriteria: eligibilityCriteria as any } : {}), ...(requiredSkills ? { requiredSkills: requiredSkills as any } : {}), ...(requiredDocuments ? { requiredDocuments: requiredDocuments as any } : {}), ...(trainingModules ? { trainingModules: trainingModules as any } : {}) } });
    await this.audit.record({ action: 'position.updated', entityType: 'JobPosition', entityId: id, before, after: input });
    return this.prisma.db.jobPosition.findFirstOrThrow({ where: { id } });
  }

  listTemplates() {
    return this.prisma.db.interviewTemplate.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createTemplate(input: { name: string; language: 'en' | 'ar'; questions: unknown[]; rubric: unknown }) {
    const err = validateTemplate(input.questions, input.rubric);
    if (err) throw new BadRequestException(err);
    const row = await this.prisma.db.interviewTemplate.create({ data: { tenantId: '', name: input.name, language: input.language, questions: input.questions as any, rubric: input.rubric as any } });
    await this.audit.record({ action: 'interview_template.created', entityType: 'InterviewTemplate', entityId: row.id, after: { name: input.name, questions: input.questions.length } });
    return row;
  }

  createDefaultTemplate(language: 'en' | 'ar') {
    const t = defaultTemplate(language);
    return this.createTemplate({ ...t, language });
  }

  listBudgets() {
    return this.prisma.db.headcountBudget.findMany();
  }

  async setBudget(input: { branchId: string; positionId: string; approved: number }) {
    const [b, p] = await Promise.all([this.prisma.db.branch.findFirst({ where: { id: input.branchId } }), this.prisma.db.jobPosition.findFirst({ where: { id: input.positionId } })]);
    if (!b || !p) throw new BadRequestException('Unknown branch or position');
    const existing = await this.prisma.db.headcountBudget.findFirst({ where: { branchId: input.branchId, positionId: input.positionId } });
    if (existing) await this.prisma.db.headcountBudget.updateMany({ where: { id: existing.id }, data: { approved: input.approved } });
    else await this.prisma.db.headcountBudget.create({ data: { tenantId: '', ...input } });
    await this.audit.record({ action: 'headcount_budget.set', entityType: 'HeadcountBudget', entityId: `${input.branchId}:${input.positionId}`, after: input });
    return this.prisma.db.headcountBudget.findFirstOrThrow({ where: { branchId: input.branchId, positionId: input.positionId } });
  }
}
