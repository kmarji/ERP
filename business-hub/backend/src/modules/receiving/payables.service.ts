import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PayableStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ammanToday, dateOnly } from '../../common/time';
import { currentContext, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, APPROVAL_DECIDED, ApprovalService } from '../workflow-engine/approval.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { WF01 } from './receiving.service';

const RELEASE = 'payable.release_payment';

@Injectable()
export class PayablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly posting: FinancePostingService,
    private readonly workflow: WorkflowEngineService,
    private readonly audit: AuditService,
  ) {}

  list(status?: PayableStatus) {
    return this.prisma.db.payable.findMany({ where: { status }, include: { invoice: true }, orderBy: { dueDate: 'asc' }, take: 300 });
  }

  async get(id: string) {
    const p = await this.prisma.db.payable.findFirst({ where: { id }, include: { invoice: { include: { lines: true } } } });
    if (!p) throw new NotFoundException('Payable not found');
    return p;
  }

  // Payment release is a high-risk action: it always needs an explicit approver other than the requester.
  async requestPayment(id: string) {
    const p = await this.get(id);
    if (p.status !== 'OPEN') throw new ConflictException(`Payable is ${p.status}`);
    const pending = await this.prisma.db.approval.findFirst({ where: { subjectType: 'Payable', subjectId: id, status: 'PENDING' } });
    if (pending) return pending;
    const decision = await this.policy.evaluate(RELEASE, { amount: Number(p.amountDue) });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Payments are blocked by policy');
    return this.approvals.request({ subjectType: 'Payable', subjectId: id, action: RELEASE, approverRole: decision.approverRole ?? 'FINANCE', amount: Number(p.amountDue) });
  }

  // Records that money actually left (outside or through an authorized channel); the bank file/transfer itself is out of scope.
  async confirmPayment(id: string, input: { reference: string; method: 'BANK' | 'CASH'; paidAt?: string }, user: RequestUser) {
    const p = await this.get(id);
    if (p.status === 'PAID') return p;
    if (p.status !== 'PAYMENT_APPROVED') throw new ConflictException('Payment must be approved before it can be confirmed');
    const paidAt = input.paidAt ? dateOnly(input.paidAt) : ammanToday();
    let journal;
    try {
      journal = await this.posting.post({
        sourceType: 'Payable',
        sourceId: p.id,
        idempotencyKey: `payment:${p.id}`,
        postingDate: paidAt,
        memo: `Payment of invoice ${p.invoice.invoiceNumber} ref ${input.reference}`,
        legalEntityId: p.legalEntityId,
        lines: [
          { account: 'AP', debit: p.amountDue },
          { account: input.method === 'CASH' ? 'CASH' : 'BANK', credit: p.amountDue },
        ],
      });
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    await this.prisma.db.payable.updateMany({ where: { id, status: 'PAYMENT_APPROVED' }, data: { status: 'PAID', paymentReference: input.reference, paymentMethod: input.method, paidAt, paymentJournalId: journal.id } });
    await this.audit.record({ action: 'payable.paid', entityType: 'Payable', entityId: id, after: { reference: input.reference, method: input.method, journal: journal.number, by: user.id } });
    const wf = await this.workflow.findBySubject(WF01, 'SupplierInvoice', p.invoiceId);
    if (wf && wf.state === 'PAYMENT_APPROVED') {
      await this.workflow.fire(wf.id, 'payment_confirmed');
      await this.workflow.fire(wf.id, 'archive');
    }
    return this.get(id);
  }

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (e.action !== RELEASE || !e.approved) return;
    await runWithTenant(e.tenantId, async () => {
      const res = await this.prisma.db.payable.updateMany({ where: { id: e.subjectId, status: 'OPEN' }, data: { status: 'PAYMENT_APPROVED', approvedBy: e.decidedBy } });
      if (res.count === 0) return;
      const p = await this.get(e.subjectId);
      const wf = await this.workflow.findBySubject(WF01, 'SupplierInvoice', p.invoiceId);
      if (wf && wf.state === 'POSTED') await this.workflow.fire(wf.id, 'payment_approved');
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }
}
