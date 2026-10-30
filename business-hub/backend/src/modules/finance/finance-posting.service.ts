import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, DecimalLike, d, money } from '../../common/money';
import { PrismaService, ScopedClient } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { currentContext, currentTenantId } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { FinanceError } from './finance.errors';

export interface PostLine {
  account: string; // ChartAccount.systemKey, or account code
  debit?: DecimalLike;
  credit?: DecimalLike;
  branchId?: string | null;
  costCenterId?: string | null;
  memo?: string;
}

export interface PostInput {
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  postingDate: Date;
  memo?: string;
  legalEntityId: string;
  branchId?: string | null;
  lines: PostLine[];
}

// Pass a transaction client to post atomically with the business write; otherwise a new transaction is opened.
type Tx = ScopedClient | Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];

@Injectable()
export class FinancePostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  async assertPeriodOpen(tx: Tx, date: Date) {
    const locked = await tx.financialPeriod.findFirst({ where: { status: 'LOCKED', startDate: { lte: date }, endDate: { gte: date } } });
    if (locked) {
      throw new FinanceError('PERIOD_LOCKED', `Financial period ${locked.startDate.toISOString().slice(0, 10)} to ${locked.endDate.toISOString().slice(0, 10)} is locked`);
    }
  }

  // One engine for every posting: balanced, idempotent, period-checked, append-only.
  post(input: PostInput, tx?: Tx) {
    return tx ? this.postIn(tx, input) : this.prisma.db.$transaction((t) => this.postIn(t, input));
  }

  private async postIn(tx: Tx, input: PostInput) {
    const existing = await tx.journal.findFirst({ where: { idempotencyKey: input.idempotencyKey }, include: { lines: true } });
    if (existing) return existing;

    await this.assertPeriodOpen(tx, input.postingDate);

    const lines = input.lines
      .map((l) => ({ ...l, debit: money(l.debit ?? 0), credit: money(l.credit ?? 0) }))
      .filter((l) => !l.debit.isZero() || !l.credit.isZero());
    if (lines.length < 2) throw new FinanceError('INVALID_JOURNAL', `A journal needs at least two non-zero lines (got ${lines.map((l) => `${l.account} Dr${l.debit} Cr${l.credit}`).join(', ') || 'none'})`);
    for (const l of lines) {
      if (l.debit.isNegative() || l.credit.isNegative() || (!l.debit.isZero() && !l.credit.isZero())) {
        throw new FinanceError('INVALID_JOURNAL', `Line for ${l.account} must be a positive debit or credit, not both`);
      }
    }
    const totalDebit = lines.reduce((s, l) => s.plus(l.debit), d(0));
    const totalCredit = lines.reduce((s, l) => s.plus(l.credit), d(0));
    if (!totalDebit.equals(totalCredit)) {
      throw new FinanceError('UNBALANCED', `Journal does not balance: debit ${totalDebit} vs credit ${totalCredit}`);
    }

    const keys = [...new Set(lines.map((l) => l.account))];
    const accounts = await tx.chartAccount.findMany({ where: { active: true, OR: [{ systemKey: { in: keys } }, { code: { in: keys } }] } });
    const byKey = new Map<string, string>();
    for (const a of accounts) {
      byKey.set(a.code, a.id);
      if (a.systemKey) byKey.set(a.systemKey, a.id);
    }
    const missing = keys.filter((k) => !byKey.has(k));
    if (missing.length) throw new FinanceError('MISSING_ACCOUNT', `No active account mapped for: ${missing.join(', ')}`);

    const number = await this.sequences.next('JOURNAL', 'JV', tx);
    const journal = await tx.journal.create({
      data: {
        tenantId: '',
        number,
        postingDate: input.postingDate,
        memo: input.memo ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        legalEntityId: input.legalEntityId,
        branchId: input.branchId ?? null,
        idempotencyKey: input.idempotencyKey,
        correlationId: currentContext()?.correlationId ?? input.idempotencyKey,
        createdBy: currentContext()?.user?.id ?? 'system',
        lines: {
          create: lines.map((l, i) => ({
            tenantId: currentTenantId(),
            lineNo: i + 1,
            accountId: byKey.get(l.account)!,
            debit: l.debit,
            credit: l.credit,
            branchId: l.branchId ?? input.branchId ?? null,
            costCenterId: l.costCenterId ?? null,
            memo: l.memo ?? null,
          })),
        },
      },
      include: { lines: true },
    });
    await this.audit.record({ action: 'journal.posted', entityType: 'Journal', entityId: journal.id, after: { number, sourceType: input.sourceType, sourceId: input.sourceId, total: totalDebit.toString() } }, tx);
    return journal;
  }

  // Corrections never edit history: a reversal is a new journal with sides swapped, linked to the original.
  async reverse(journalId: string, reason: string, postingDate: Date = new Date()) {
    return this.prisma.db.$transaction(async (tx) => {
      const original = await tx.journal.findFirst({ where: { id: journalId }, include: { lines: { include: { account: true } } } });
      if (!original) throw new NotFoundException('Journal not found');
      if (original.reversalOfId) throw new ConflictException('A reversal cannot itself be reversed; post a new correcting entry');
      const already = await tx.journal.findFirst({ where: { reversalOfId: journalId } });
      if (already) throw new ConflictException(`Journal already reversed by ${already.number}`);
      try {
        const reversal = await this.postReversal(tx, original, reason, postingDate);
        return reversal;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Journal already reversed');
        throw e;
      }
    });
  }

  private async postReversal(tx: Tx, original: any, reason: string, postingDate: Date) {
    await this.assertPeriodOpen(tx, postingDate);
    const number = await this.sequences.next('JOURNAL', 'JV', tx);
    const reversal = await tx.journal.create({
      data: {
        tenantId: '',
        number,
        postingDate,
        memo: `Reversal of ${original.number}: ${reason}`,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        legalEntityId: original.legalEntityId,
        branchId: original.branchId,
        reversalOfId: original.id,
        idempotencyKey: `reversal:${original.id}`,
        correlationId: currentContext()?.correlationId ?? original.id,
        createdBy: currentContext()?.user?.id ?? 'system',
        lines: {
          create: original.lines.map((l: any, i: number) => ({
            tenantId: currentTenantId(),
            lineNo: i + 1,
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            branchId: l.branchId,
            costCenterId: l.costCenterId,
            memo: `Reversal: ${l.memo ?? ''}`.trim(),
          })),
        },
      },
      include: { lines: true },
    });
    await this.audit.record({ action: 'journal.reversed', entityType: 'Journal', entityId: original.id, after: { reversal: reversal.number, reason } }, tx);
    return reversal;
  }

  // Net balance (debit - credit) of an account up to a date, optionally for one tenant-scoped client/tx.
  async balance(accountKey: string, asOf?: Date, tx: Tx = this.prisma.db): Promise<Decimal> {
    const acct = await tx.chartAccount.findFirst({ where: { OR: [{ systemKey: accountKey }, { code: accountKey }] } });
    if (!acct) return d(0);
    const agg = await tx.journalLine.aggregate({
      where: { accountId: acct.id, ...(asOf ? { journal: { postingDate: { lte: asOf } } } : {}) },
      _sum: { debit: true, credit: true },
    });
    return d(agg._sum.debit).minus(d(agg._sum.credit));
  }
}
