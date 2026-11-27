import { ownDutyRule } from '../audit/owner-override';
import { Attachment, attachmentSnapshot } from './attachments';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { DocumentsService } from '../documents/documents.module';
import { NotificationsService } from '../notifications/notifications.module';
import { employeeOf, MANAGERS, primaryBranch } from '../workforce/common';
import { QuestionGenAdapter } from './question-gen';

const OPEN = ['ASSIGNED', 'IN_PROGRESS', 'EXAM_PENDING'] as const;
const shuffle = <T>(a: T[]) => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);

@Injectable()
export class LearningService {
  private readonly log = new Logger(LearningService.name);

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly gen: QuestionGenAdapter, private readonly notes: NotificationsService, private readonly docs: DocumentsService) {}

  private companyWide(user: RequestUser) {
    if (!user.roles.some((r) => r.branchId === null && MANAGERS.includes(r.key as any))) throw new ForbiddenException('Only a company-wide role can change the library, question banks and rules');
  }

  private async canManage(employeeId: string, user: RequestUser) {
    const b = await primaryBranch(this.prisma, employeeId, new Date());
    if (b) assertBranchAccess(user, b, MANAGERS);
    else this.companyWide(user);
  }

  // ---------------------------------------------------------------- A51 library

  library(includeOld = false) {
    return this.prisma.db.libraryItem.findMany({ where: includeOld ? {} : { active: true }, orderBy: [{ title: 'asc' }, { version: 'desc' }] });
  }

  async saveItem(input: { code?: string; kind: string; title: string; body: string; attachmentIds?: string[]; passScore?: number; maxAttempts?: number; questionsPerAttempt?: number }, user: RequestUser) {
    this.companyWide(user);
    const code = input.code ?? randomUUID().slice(0, 8);
    const last = await this.prisma.db.libraryItem.findFirst({ where: { code }, orderBy: { version: 'desc' } });
    if (input.code && !last) throw new NotFoundException('Unknown item code');
    const attachments = input.attachmentIds ? await attachmentSnapshot(this.prisma, this.docs, user, input.attachmentIds) : ((last?.attachments as unknown as Attachment[]) ?? []);
    if (input.body.trim().length < 10 && !attachments.length) throw new BadRequestException('Write the material (at least 10 characters) or attach a file');
    const row = await this.prisma.db.$transaction(async (tx) => {
      if (last) await tx.libraryItem.updateMany({ where: { code }, data: { active: false } });
      return tx.libraryItem.create({ data: { tenantId: currentTenantId(), code, version: (last?.version ?? 0) + 1, kind: input.kind, title: input.title, body: input.body, attachments: attachments as any, passScore: input.passScore ?? last?.passScore ?? 80, maxAttempts: input.maxAttempts ?? last?.maxAttempts ?? 3, questionsPerAttempt: input.questionsPerAttempt ?? last?.questionsPerAttempt ?? 5, createdBy: user.id } });
    });
    await this.audit.record({ action: 'library.item_saved', entityType: 'LibraryItem', entityId: row.id, after: { code, version: row.version, kind: row.kind } });
    return row;
  }

  private async item(id: string) {
    const i = await this.prisma.db.libraryItem.findFirst({ where: { id } });
    if (!i) throw new NotFoundException('Library item not found');
    return i;
  }

  // ---------------------------------------------------------------- A53 question bank

  // The bank includes the answer key, so someone still sitting this exam cannot read it.
  async questions(itemCode: string, user: RequestUser, status?: string) {
    const me = await this.prisma.db.employee.findFirst({ where: { userId: user.id } });
    await ownDutyRule(!!(me && (await this.prisma.db.trainingAssignment.findFirst({ where: { employeeId: me.id, itemCode, status: { in: ['ASSIGNED', 'IN_PROGRESS', 'EXAM_PENDING', 'FAILED'] } } }))), user, this.audit, 'LibraryItem', itemCode, 'You are taking this exam, so you cannot read its questions');
    return this.prisma.db.questionBankItem.findMany({ where: { itemCode, status }, orderBy: { createdAt: 'desc' }, take: 300 });
  }

  private checkQ(q: { options: string[]; correctIndex: number }) {
    if (q.options.length < 2 || q.options.length > 6 || new Set(q.options.map((o) => o.trim().toLowerCase())).size !== q.options.length) throw new BadRequestException('Give 2 to 6 distinct options');
    if (q.correctIndex < 0 || q.correctIndex >= q.options.length) throw new BadRequestException('correctIndex is outside the options');
  }

  // A manager writing a question is the approver; generated ones wait as DRAFT.
  async addQuestion(itemCode: string, q: { text: string; options: string[]; correctIndex: number }, user: RequestUser) {
    this.companyWide(user);
    this.checkQ(q);
    if (!(await this.prisma.db.libraryItem.findFirst({ where: { code: itemCode } }))) throw new NotFoundException('Unknown item code');
    return this.prisma.db.questionBankItem.create({ data: { tenantId: '', itemCode, text: q.text, options: q.options, correctIndex: q.correctIndex, status: 'APPROVED', source: 'MANUAL', createdBy: user.id, approvedBy: user.id, approvedAt: new Date() } });
  }

  async generate(itemCode: string, count: number, user: RequestUser) {
    this.companyWide(user);
    const item = await this.prisma.db.libraryItem.findFirst({ where: { code: itemCode, active: true } });
    if (!item) throw new NotFoundException('No active item with that code');
    // Text can only be read from the written material and plain-text attachments; PDFs, Office files and videos are not parsed.
    let body = item.body;
    for (const a of (item.attachments as unknown as Attachment[]) ?? []) {
      if (/^text\//.test(a.mimeType) || /\.(txt|md|csv)$/i.test(a.filename)) body += `\n${(await this.docs.read(a.id)).data.subarray(0, 200_000).toString('utf8')}`; // cap text read per attachment
    }
    const made = await this.gen.generate({ title: item.title, body, count });
    if (!made.length) throw new BadRequestException('No questions could be generated: the written material is too short. Paste the key text of the PDF, slides or video into the material box (files and videos are not read), then try again.');
    for (const q of made) this.checkQ(q);
    await this.prisma.db.questionBankItem.createMany({ data: made.map((q) => ({ tenantId: currentTenantId(), itemCode, text: q.text, options: q.options, correctIndex: q.correctIndex, source: this.gen.name, createdBy: user.id })) });
    await this.audit.record({ action: 'question_bank.generated', entityType: 'LibraryItem', entityId: item.id, after: { generator: this.gen.name, drafts: made.length } });
    return { drafts: made.length, generator: this.gen.name };
  }

  async decideQuestion(id: string, approve: boolean, user: RequestUser) {
    this.companyWide(user);
    const q = await this.prisma.db.questionBankItem.findFirst({ where: { id } });
    if (!q) throw new NotFoundException('Question not found');
    if (q.status !== 'DRAFT' && approve === (q.status === 'APPROVED')) return q;
    await this.prisma.db.questionBankItem.updateMany({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', approvedBy: user.id, approvedAt: new Date() } });
    await this.audit.record({ action: approve ? 'question.approved' : 'question.rejected', entityType: 'QuestionBankItem', entityId: id });
    return this.prisma.db.questionBankItem.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- A52 assignment (manual and by position)

  // Refuses an item that cannot be examined: every assigned training needs an exam.
  async assign(input: { employeeId: string; itemId: string; dueDate?: string }, user: RequestUser | null, source: 'MANUAL' | 'AUTO' = 'MANUAL') {
    if (user) await this.canManage(input.employeeId, user);
    const item = await this.item(input.itemId);
    if (!item.active) throw new BadRequestException('That version is retired; assign the current one');
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } });
    if (!emp || !['ACTIVE', 'ONBOARDING'].includes(emp.status)) throw new BadRequestException('Employee is not active');
    const approved = await this.prisma.db.questionBankItem.count({ where: { itemCode: item.code, status: 'APPROVED' } });
    if (approved < item.questionsPerAttempt) throw new ConflictException(`Needs an exam first: ${approved} approved question(s), ${item.questionsPerAttempt} required`);
    if (await this.prisma.db.trainingAssignment.findFirst({ where: { employeeId: emp.id, itemCode: item.code, status: { in: [...OPEN] } } })) throw new ConflictException('Already assigned and not finished');
    const row = await this.prisma.db.trainingAssignment.create({ data: { tenantId: '', employeeId: emp.id, title: item.title, mandatory: true, dueDate: input.dueDate ? new Date(`${input.dueDate.slice(0, 10)}T00:00:00Z`) : null, libraryItemId: item.id, itemCode: item.code, source, assignedBy: user?.id ?? null } });
    if (emp.userId) await this.notes.notify({ userId: emp.userId, title: `Training assigned: ${item.title}`, body: input.dueDate ? `Due ${input.dueDate.slice(0, 10)}` : undefined });
    await this.audit.record({ action: 'training.assigned', entityType: 'TrainingAssignment', entityId: row.id, after: { employeeId: emp.id, code: item.code, source } });
    return row;
  }

  // A new hire gets every exam-backed module of the position, matched by library code or by exact title.
  // A module that cannot be examined is never assigned as a bare title: HR gets a task to fix the library instead.
  async assignForHire(employeeId: string, modules: { title: string; itemCode?: string; dueDays?: number }[], startDate: Date) {
    const emp = await this.prisma.db.employee.findFirst({ where: { id: employeeId } });
    const problems: string[] = [];
    for (const m of modules) {
      const items = await this.prisma.db.libraryItem.findMany({ where: { active: true, ...(m.itemCode ? { code: m.itemCode } : {}) } });
      const item = m.itemCode ? items[0] : items.find((i) => i.title.trim().toLowerCase() === m.title.trim().toLowerCase());
      try {
        if (!item) throw new Error('no library item with that name');
        await this.assign({ employeeId, itemId: item.id, dueDate: new Date(startDate.getTime() + (m.dueDays ?? 30) * 86_400_000).toISOString() }, null, 'AUTO');
      } catch (e: any) {
        problems.push(m.title);
        await this.prisma.db.task.create({ data: { tenantId: '', title: `Training "${m.title}" was not assigned to ${emp?.name ?? 'a new hire'}: ${e.message}. Fix it under Training & SOPs, then assign it.`, assigneeRole: 'HR' } });
      }
    }
    return { problems };
  }

  rules() { return this.prisma.db.trainingRule.findMany({ where: { active: true } }); }

  async saveRule(input: { positionId: string; itemCode: string; dueDays?: number }, user: RequestUser) {
    this.companyWide(user);
    if (!(await this.prisma.db.jobPosition.findFirst({ where: { id: input.positionId } }))) throw new BadRequestException('Unknown position');
    if (!(await this.prisma.db.libraryItem.findFirst({ where: { code: input.itemCode, active: true } }))) throw new BadRequestException('Unknown item code');
    await this.prisma.db.trainingRule.upsert({ where: { tenantId_positionId_itemCode: { tenantId: currentTenantId(), positionId: input.positionId, itemCode: input.itemCode } }, create: { tenantId: currentTenantId(), positionId: input.positionId, itemCode: input.itemCode, dueDays: input.dueDays ?? 30, createdBy: user.id }, update: { dueDays: input.dueDays ?? 30, active: true } });
    return this.applyRules();
  }

  async stopRule(id: string, user: RequestUser) {
    this.companyWide(user);
    await this.prisma.db.trainingRule.updateMany({ where: { id }, data: { active: false } });
    return { stopped: true };
  }

  // Each active employee in a rule's position gets that item once, ever (a pass or a fail is not re-assigned automatically).
  async applyRules() {
    let assigned = 0;
    const skipped: string[] = [];
    for (const rule of await this.rules()) {
      const item = await this.prisma.db.libraryItem.findFirst({ where: { code: rule.itemCode, active: true } });
      if (!item) continue;
      const emps = await this.prisma.db.employee.findMany({ where: { positionId: rule.positionId, status: { in: ['ACTIVE', 'ONBOARDING'] } } });
      for (const e of emps) {
        if (await this.prisma.db.trainingAssignment.findFirst({ where: { employeeId: e.id, itemCode: rule.itemCode } })) continue;
        try {
          await this.assign({ employeeId: e.id, itemId: item.id, dueDate: new Date(Date.now() + rule.dueDays * 86_400_000).toISOString() }, null, 'AUTO');
          assigned++;
        } catch (err: any) { skipped.push(`${rule.itemCode}: ${err.message}`); break; } // e.g. the bank is not ready; try again next sweep
      }
    }
    return { assigned, skipped };
  }

  @Cron('*/30 * * * *')
  async cron() {
    const tenants = await this.prisma.raw.tenant.findMany({ where: { active: true }, select: { id: true } });
    for (const t of tenants) await runWithTenant(t.id, () => this.applyRules()).catch((err) => this.log.error(`training rules failed for ${t.id}: ${err.message}`));
  }

  async overview(f: { employeeId?: string; status?: string }, user: RequestUser) {
    if (f.employeeId) await this.canManage(f.employeeId, user); // an explicit employee must be one the caller may manage
    const b = [...user.roles.filter((r) => MANAGERS.includes(r.key as any)).map((r) => r.branchId), ...user.delegations.filter((d) => MANAGERS.includes(d.roleKey as any)).map((d) => d.branchId)];
    let employeeIds: string[] | undefined;
    if (!b.includes(null)) employeeIds = [...new Set((await this.prisma.db.employeeAssignment.findMany({ where: { branchId: { in: b as string[] }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.employeeId))];
    return this.prisma.db.trainingAssignment.findMany({ where: { itemCode: { not: null }, employeeId: f.employeeId ?? (employeeIds ? { in: employeeIds } : undefined), status: f.status as any }, orderBy: { dueDate: 'asc' }, take: 300 });
  }

  async reset(id: string, user: RequestUser) {
    const a = await this.prisma.db.trainingAssignment.findFirst({ where: { id, itemCode: { not: null } } });
    if (!a) throw new NotFoundException('Assignment not found');
    await this.canManage(a.employeeId, user);
    await ownDutyRule((await this.prisma.db.employee.findFirst({ where: { id: a.employeeId } }))?.userId === user.id, user, this.audit, 'TrainingAssignment', a.id, 'You cannot give yourself new attempts');
    if (a.status !== 'FAILED') throw new ConflictException('Only a failed assignment can be given new attempts');
    await this.prisma.db.trainingAssignment.updateMany({ where: { id }, data: { status: 'IN_PROGRESS', attempts: 0 } });
    await this.audit.record({ action: 'training.attempts_reset', entityType: 'TrainingAssignment', entityId: id, after: { by: user.id } });
    return this.prisma.db.trainingAssignment.findFirstOrThrow({ where: { id } });
  }

  // ---------------------------------------------------------------- E14-E16 employee side

  private async mineRow(id: string, user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const a = await this.prisma.db.trainingAssignment.findFirst({ where: { id, employeeId: me.id, itemCode: { not: null } } });
    if (!a) throw new NotFoundException('Training not found');
    return a;
  }

  async mine(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const rows = await this.prisma.db.trainingAssignment.findMany({ where: { employeeId: me.id, itemCode: { not: null } }, orderBy: { dueDate: 'asc' } });
    const items = await this.prisma.db.libraryItem.findMany({ where: { id: { in: rows.map((r) => r.libraryItemId!) } }, select: { id: true, kind: true, version: true, passScore: true, maxAttempts: true } });
    return rows.map((r) => ({ ...r, item: items.find((i) => i.id === r.libraryItemId) }));
  }

  // Reading the material moves the training to IN_PROGRESS.
  async open(id: string, user: RequestUser) {
    const a = await this.mineRow(id, user);
    if (a.status === 'ASSIGNED') await this.prisma.db.trainingAssignment.updateMany({ where: { id, status: 'ASSIGNED' }, data: { status: 'IN_PROGRESS' } });
    return { assignment: await this.prisma.db.trainingAssignment.findFirstOrThrow({ where: { id } }), item: await this.item(a.libraryItemId!) };
  }

  // Varied exams: a random sample of the approved bank with shuffled options. An unfinished attempt is resumed, not re-rolled.
  async startExam(id: string, user: RequestUser) {
    const a = await this.mineRow(id, user);
    if (!['IN_PROGRESS', 'EXAM_PENDING'].includes(a.status)) throw new ConflictException(a.status === 'ASSIGNED' ? 'Read the material first' : `Training is ${a.status}`);
    const item = await this.item(a.libraryItemId!);
    const open = await this.prisma.db.examAttempt.findFirst({ where: { assignmentId: id, submittedAt: null } });
    if (open) return this.present(open);
    if (a.attempts >= item.maxAttempts) throw new ConflictException('No attempts left; ask your manager');
    const bank = await this.prisma.db.questionBankItem.findMany({ where: { itemCode: a.itemCode!, status: 'APPROVED' } });
    if (bank.length < item.questionsPerAttempt) throw new ConflictException('The exam is not ready');
    const questions = shuffle(bank).slice(0, item.questionsPerAttempt).map((q) => {
      const opts = shuffle((q.options as string[]).map((text, i) => ({ text, ok: i === q.correctIndex })));
      return { id: q.id, text: q.text, options: opts.map((o) => o.text), correctIndex: opts.findIndex((o) => o.ok) };
    });
    const attempt = await this.prisma.db.examAttempt.create({ data: { tenantId: '', assignmentId: id, employeeId: a.employeeId, questions } });
    await this.prisma.db.trainingAssignment.updateMany({ where: { id }, data: { status: 'EXAM_PENDING', attempts: { increment: 1 } } });
    return this.present(attempt);
  }

  private present(a: { id: string; questions: any }) {
    return { attemptId: a.id, questions: (a.questions as any[]).map((q) => ({ id: q.id, text: q.text, options: q.options })) };
  }

  async submit(attemptId: string, answers: { questionId: string; index: number }[], user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const at = await this.prisma.db.examAttempt.findFirst({ where: { id: attemptId, employeeId: me.id } });
    if (!at) throw new NotFoundException('Attempt not found');
    if (at.submittedAt) return { score: at.score, passed: at.passed, alreadySubmitted: true };
    const a = await this.prisma.db.trainingAssignment.findFirstOrThrow({ where: { id: at.assignmentId } });
    const item = await this.item(a.libraryItemId!);
    const qs = at.questions as any[];
    const right = qs.filter((q) => answers.find((x) => x.questionId === q.id)?.index === q.correctIndex).length;
    const score = Math.round((right / qs.length) * 100);
    const passed = score >= item.passScore;
    const { count } = await this.prisma.db.examAttempt.updateMany({ where: { id: attemptId, submittedAt: null }, data: { answers: answers as any, score, passed, submittedAt: new Date() } });
    if (!count) return { score: at.score, passed: at.passed, alreadySubmitted: true };
    const exhausted = a.attempts >= item.maxAttempts;
    await this.prisma.db.trainingAssignment.updateMany({ where: { id: a.id }, data: { status: passed ? 'PASSED' : exhausted ? 'FAILED' : 'EXAM_PENDING', bestScore: Math.max(a.bestScore ?? 0, score), completedAt: passed ? new Date() : null } });
    await this.audit.record({ action: passed ? 'exam.passed' : 'exam.failed', entityType: 'TrainingAssignment', entityId: a.id, after: { score, attempt: a.attempts } });
    return { score, passed, passScore: item.passScore, attemptsLeft: passed ? 0 : Math.max(0, item.maxAttempts - a.attempts) };
  }

  // ---------------------------------------------------------------- A55 evaluations

  async evaluate(input: { employeeId: string; topic: string; rating: number; notes?: string }, user: RequestUser) {
    await this.canManage(input.employeeId, user);
    const emp = await this.prisma.db.employee.findFirst({ where: { id: input.employeeId } });
    if (!emp) throw new BadRequestException('Unknown employee');
    await ownDutyRule(emp.userId === user.id, user, this.audit, 'Employee', emp.id, 'You cannot evaluate yourself');
    const row = await this.prisma.db.employeeEvaluation.create({ data: { tenantId: '', employeeId: emp.id, evaluatorId: user.id, topic: input.topic, rating: input.rating, notes: input.notes ?? null } });
    await this.audit.record({ action: 'evaluation.recorded', entityType: 'EmployeeEvaluation', entityId: row.id, after: { employeeId: emp.id, rating: input.rating } });
    return row;
  }

  async evaluations(employeeId: string, user: RequestUser) {
    if (typeof employeeId !== 'string' || !employeeId.trim()) throw new BadRequestException('employeeId is required');
    await this.canManage(employeeId, user);
    return this.prisma.db.employeeEvaluation.findMany({ where: { employeeId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async myResults(user: RequestUser) {
    const me = await employeeOf(this.prisma, user);
    const [exams, evaluations] = await Promise.all([
      this.prisma.db.trainingAssignment.findMany({ where: { employeeId: me.id, itemCode: { not: null }, status: { in: ['PASSED', 'FAILED'] } }, orderBy: { completedAt: 'desc' } }),
      this.prisma.db.employeeEvaluation.findMany({ where: { employeeId: me.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return { exams, evaluations };
  }
}
