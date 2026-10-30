import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ammanToday, dateOnly } from '../../common/time';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { FinanceError } from '../finance/finance.errors';
import { FinancePostingService } from '../finance/finance-posting.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { TENDER_ACCOUNT } from './sales-posting.service';

export const MARKETPLACES = ['TALABAT', 'CAREEM'];

export interface StatementLine {
  reference: string;
  amount: Decimal;
}

export interface MatchableTender {
  id: string;
  orderId: string;
  reference: string | null;
  amount: Decimal;
}

// Pure matching of a payout statement against captured card tenders, by terminal reference then amount.
export function matchSettlement(lines: StatementLine[], tenders: MatchableTender[]) {
  const pool = new Map<string, MatchableTender[]>();
  for (const t of tenders) if (t.reference) pool.set(t.reference, [...(pool.get(t.reference) ?? []), t]);
  const matched: { line: StatementLine; tender: MatchableTender }[] = [];
  const amountMismatch: { line: StatementLine; tender: MatchableTender }[] = [];
  const unknown: StatementLine[] = [];
  for (const line of lines) {
    const candidates = pool.get(line.reference) ?? [];
    const tender = candidates.shift();
    if (!tender) unknown.push(line);
    else if (d(tender.amount).equals(line.amount)) matched.push({ line, tender });
    else amountMismatch.push({ line, tender });
  }
  return { matched, amountMismatch, unknown };
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: FinancePostingService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.db.settlement.findMany({ include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async get(id: string) {
    const s = await this.prisma.db.settlement.findFirst({ where: { id }, include: { lines: true } });
    if (!s) throw new NotFoundException('Settlement not found');
    return s;
  }

  // POS-03: auto-match reliable payouts; anything else becomes an exception for finance.
  async import(input: { provider: string; settlementDate: string; reference: string; gross: number; fees: number; net: number; lines: { reference: string; amount: number }[] }, user: RequestUser) {
    const gross = money(input.gross);
    const fees = money(input.fees);
    const net = money(input.net);
    if (!gross.minus(fees).equals(net)) throw new BadRequestException(`Statement does not add up: gross ${gross} - fees ${fees} != net ${net}`);
    const lines = input.lines.map((l) => ({ reference: l.reference, amount: money(l.amount) }));
    const linesTotal = lines.reduce((s, l) => s.plus(l.amount), d(0));

    // Marketplace payouts clear the marketplace receivable; card acquirers clear card clearing.
    const methods = MARKETPLACES.includes(input.provider) ? (['MARKETPLACE'] as const) : (['CARD', 'DIGITAL'] as const);
    const tenders = await this.prisma.db.tender.findMany({ where: { method: { in: [...methods] }, status: 'CAPTURED', settlementId: null, reference: { in: lines.map((l) => l.reference) } } });
    const m = matchSettlement(lines, tenders.map((t) => ({ id: t.id, orderId: t.orderId, reference: t.reference, amount: d(t.amount) })));
    const clean = !m.amountMismatch.length && !m.unknown.length && linesTotal.equals(gross);

    let settlement;
    try {
      settlement = await this.prisma.db.settlement.create({
        data: {
          tenantId: '',
          provider: input.provider,
          settlementDate: dateOnly(input.settlementDate),
          reference: input.reference,
          gross,
          fees,
          net,
          status: 'EXCEPTION',
          createdBy: user.id,
          lines: {
            create: [
              ...m.matched.map((x) => ({ tenantId: currentTenantId(), reference: x.line.reference, amount: x.line.amount, tenderId: x.tender.id, orderId: x.tender.orderId, matched: true })),
              ...m.amountMismatch.map((x) => ({ tenantId: currentTenantId(), reference: x.line.reference, amount: x.line.amount, tenderId: x.tender.id, orderId: x.tender.orderId, matched: false, note: `Statement ${x.line.amount} vs tender ${x.tender.amount}` })),
              ...m.unknown.map((x) => ({ tenantId: currentTenantId(), reference: x.reference, amount: x.amount, matched: false, note: 'No captured tender with this reference (unknown or disputed charge)' })),
            ],
          },
        },
        include: { lines: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('This settlement statement was already imported');
      throw e;
    }

    if (clean) {
      try {
        return await this.postMatched(settlement.id);
      } catch (e) {
        if (!(e instanceof FinanceError)) throw e;
        await this.exceptions.raise({ code: 'POS_SETTLEMENT_POST_FAILED', reason: `Settlement ${input.reference} matched but could not be posted: ${e.message}`, evidence: { settlementId: settlement.id }, amount: Number(gross), ownerRole: 'FINANCE', riskTier: 'MEDIUM', availableActions: ['resolve'] });
        return this.get(settlement.id);
      }
    }
    await this.exceptions.raise({
      code: 'POS_SETTLEMENT_MISMATCH',
      reason: `Settlement ${input.reference} from ${input.provider} does not reconcile: ${m.unknown.length} unknown line(s), ${m.amountMismatch.length} amount difference(s)${linesTotal.equals(gross) ? '' : `, lines total ${linesTotal} vs gross ${gross}`}`,
      evidence: { settlementId: settlement.id, unknown: m.unknown.map((x) => ({ reference: x.reference, amount: x.amount.toString() })), mismatched: m.amountMismatch.map((x) => ({ reference: x.line.reference, statement: x.line.amount.toString(), tender: x.tender.amount.toString() })) },
      impact: 'Card clearing is not cleared and the bank receipt is not booked until this is resolved',
      amount: Number(gross),
      ownerRole: 'FINANCE',
      riskTier: 'MEDIUM',
      availableActions: ['resolve'],
    });
    await this.audit.record({ action: 'settlement.imported_with_exceptions', entityType: 'Settlement', entityId: settlement.id, outcome: 'FAILURE' });
    return this.get(settlement.id);
  }

  // Books the bank receipt and fees against card clearing and links tenders to the payout. Any difference between what
  // the bank paid and what the matched tenders say goes to cash over/short, so nothing stays hidden.
  private async postMatched(settlementId: string) {
    await this.prisma.db.$transaction(async (tx) => {
      const s = await tx.settlement.findFirstOrThrow({ where: { id: settlementId }, include: { lines: true } });
      const matchedLines = s.lines.filter((l) => l.matched && l.orderId);
      const firstOrder = matchedLines.length ? await tx.order.findFirst({ where: { id: matchedLines[0].orderId! } }) : null;
      const branch = firstOrder ? await tx.branch.findFirst({ where: { id: firstOrder.branchId } }) : null;
      const legalEntityId = branch?.legalEntityId ?? (await tx.legalEntity.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
      // Card clearing was debited at each tender's own amount, so that is what gets cleared, whatever the statement says.
      const tenderIds = s.lines.filter((l) => l.matched && l.tenderId).map((l) => l.tenderId!);
      const tenders = await tx.tender.findMany({ where: { id: { in: tenderIds } } });
      const matchedGross = tenders.reduce((sum, t) => sum.plus(t.amount), d(0));
      const variance = d(s.gross).minus(matchedGross); // positive: the payer paid more than the cleared tenders
      const clearing = new Map<string, Decimal>();
      for (const t of tenders) clearing.set(TENDER_ACCOUNT[t.method], (clearing.get(TENDER_ACCOUNT[t.method]) ?? d(0)).plus(t.amount));
      if (!clearing.size) clearing.set(MARKETPLACES.includes(s.provider) ? 'MARKETPLACE_CLEARING' : 'CARD_CLEARING', d(0));
      const journal = await this.posting.post(
        {
          sourceType: 'Settlement',
          sourceId: s.id,
          idempotencyKey: `settlement:${s.id}`,
          postingDate: ammanToday(),
          memo: `${s.provider} settlement ${s.reference}`,
          legalEntityId,
          branchId: branch?.id,
          lines: [
            { account: 'BANK', debit: s.net },
            { account: 'COMMISSION_EXPENSE', debit: s.fees },
            ...[...clearing].map(([account, credit]) => ({ account, credit })),
            { account: 'CASH_VARIANCE', debit: variance.isNegative() ? variance.abs() : 0, credit: variance.gt(0) ? variance : 0 },
          ],
        },
        tx,
      );
      await tx.tender.updateMany({ where: { id: { in: tenderIds } }, data: { settlementId: s.id } });
      await tx.settlement.updateMany({ where: { id: s.id }, data: { status: 'MATCHED', journalId: journal.id } });
      await this.audit.record({ action: 'settlement.matched', entityType: 'Settlement', entityId: s.id, after: { gross: s.gross.toString(), fees: s.fees.toString(), net: s.net.toString(), variance: variance.toString() } }, tx);
    });
    return this.get(settlementId);
  }

  // Finance accepts the statement after investigating. Lines that matched clear card clearing; the difference between
  // what the bank paid net of fees and what the tenders say is booked to cash over/short so nothing stays hidden.
  async resolve(settlementId: string, input: { accept: boolean; reason: string }, user: RequestUser) {
    const s = await this.get(settlementId);
    if (s.status === 'MATCHED') return s;
    if (!input.accept) throw new BadRequestException('Nothing to do: the settlement stays in exception until accepted or the data is corrected');
    const matchedGross = s.lines.filter((l) => l.matched).reduce((sum, l) => sum.plus(l.amount), d(0));
    const variance = money(d(s.gross).minus(matchedGross));
    try {
      // Finance has investigated and accepts the statement: lines that point at a tender are cleared against it.
      await this.prisma.db.settlementLine.updateMany({ where: { settlementId, tenderId: { not: null } }, data: { matched: true } });
      await this.postMatched(settlementId);
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    await this.audit.record({ action: 'settlement.accepted_with_differences', entityType: 'Settlement', entityId: settlementId, after: { reason: input.reason, by: user.id, variance: variance.toString() } });
    const open = await this.prisma.db.exception.findMany({ where: { code: 'POS_SETTLEMENT_MISMATCH', status: 'NOTIFIED' } });
    for (const ex of open.filter((e) => (e.evidence as any)?.settlementId === settlementId)) {
      await this.exceptions.transition(ex.id, 'RESOLVED', input.reason);
      await this.exceptions.transition(ex.id, 'EXECUTED', 'Booked with differences to cash over/short');
      await this.exceptions.transition(ex.id, 'VERIFIED', 'Settlement journal balanced');
    }
    return this.get(settlementId);
  }

  // Missing payouts: card sales still unsettled after the provider's usual payout window.
  async findMissingPayouts(olderThanDays = 3) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const stale = await this.prisma.db.tender.findMany({ where: { method: { in: ['CARD', 'DIGITAL', 'MARKETPLACE'] }, status: 'CAPTURED', settlementId: null, capturedAt: { lt: cutoff } }, take: 500 });
    if (!stale.length) return { missing: 0, total: '0' };
    const total = stale.reduce((s, t) => s.plus(t.amount), d(0));
    const open = await this.prisma.db.exception.findMany({ where: { code: 'POS_PAYOUT_MISSING', status: 'NOTIFIED' } });
    if (!open.length) {
      await this.exceptions.raise({
        code: 'POS_PAYOUT_MISSING',
        reason: `${stale.length} card payment(s) worth ${money(total)} JOD were captured more than ${olderThanDays} days ago and have no settlement`,
        evidence: { tenderIds: stale.slice(0, 100).map((t) => t.id), olderThanDays },
        impact: 'Possible missing payout; money may be stuck with the card provider',
        amount: Number(total),
        ownerRole: 'FINANCE',
        riskTier: 'MEDIUM',
        availableActions: ['resolve'],
      });
    }
    return { missing: stale.length, total: money(total).toString() };
  }
}
