import { BadRequestException, Body, Controller, Get, Global, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { AccountType } from '@prisma/client';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { FinanceError } from './finance.errors';
import { FinancePostingService } from './finance-posting.service';

class AccountDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsEnum(AccountType) type!: AccountType;
}

class PeriodDto {
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
}

class JournalLineDto {
  @IsString() account!: string;
  @IsOptional() @IsNumber() @Min(0) debit?: number;
  @IsOptional() @IsNumber() @Min(0) credit?: number;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() memo?: string;
}

class ManualJournalDto {
  @IsDateString() postingDate!: string;
  @IsString() memo!: string;
  @IsString() idempotencyKey!: string;
  @IsString() legalEntityId!: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => JournalLineDto) lines!: JournalLineDto[];
}

class ReverseDto {
  @IsString() reason!: string;
}

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

@ApiTags('finance')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE')
@Controller('finance')
class FinanceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: FinancePostingService,
    private readonly audit: AuditService,
  ) {}

  @Get('accounts') accounts() {
    return this.prisma.db.chartAccount.findMany({ orderBy: { code: 'asc' } });
  }

  @Post('accounts') async addAccount(@Body() dto: AccountDto) {
    const row = await this.prisma.db.chartAccount.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'account.created', entityType: 'ChartAccount', entityId: row.id, after: row });
    return row;
  }

  @Get('periods') periods() {
    return this.prisma.db.financialPeriod.findMany({ orderBy: { startDate: 'desc' } });
  }

  // Locking a period blocks every posting dated inside it; unlocking is reserved for the owner.
  @Post('periods/lock') async lock(@Body() dto: PeriodDto, @CurrentUser() u: RequestUser) {
    const start = day(dto.startDate);
    const end = day(dto.endDate);
    if (end < start) throw new BadRequestException('endDate before startDate');
    const row = await this.prisma.db.financialPeriod.upsert({
      where: { tenantId_startDate: { tenantId: u.tenantId, startDate: start } },
      create: { tenantId: u.tenantId, startDate: start, endDate: end, status: 'LOCKED', lockedBy: u.id, lockedAt: new Date() },
      update: { endDate: end, status: 'LOCKED', lockedBy: u.id, lockedAt: new Date() },
    });
    await this.audit.record({ action: 'period.locked', entityType: 'FinancialPeriod', entityId: row.id, after: row });
    return row;
  }

  @Post('periods/:id/unlock') async unlock(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    if (!actorHasRole(u, 'OWNER')) throw new BadRequestException('Only the owner can unlock a financial period');
    await this.prisma.db.financialPeriod.updateMany({ where: { id }, data: { status: 'OPEN', lockedBy: null, lockedAt: null } });
    await this.audit.record({ action: 'period.unlocked', entityType: 'FinancialPeriod', entityId: id });
    return { unlocked: true };
  }

  @Get('journals') journals(@Query('sourceType') sourceType?: string, @Query('sourceId') sourceId?: string, @Query('take') take?: string) {
    return this.prisma.db.journal.findMany({
      where: { sourceType, sourceId },
      include: { lines: { include: { account: true }, orderBy: { lineNo: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(take ?? 50), 200),
    });
  }

  @Get('journals/:id') async journal(@Param('id') id: string) {
    const j = await this.prisma.db.journal.findFirst({ where: { id }, include: { lines: { include: { account: true } }, reversedBy: true, reversalOf: true } });
    if (!j) throw new NotFoundException();
    return j;
  }

  @Post('journals') async manual(@Body() dto: ManualJournalDto) {
    try {
      return await this.posting.post({
        sourceType: 'MANUAL',
        sourceId: dto.idempotencyKey,
        idempotencyKey: `manual:${dto.idempotencyKey}`,
        postingDate: day(dto.postingDate),
        memo: dto.memo,
        legalEntityId: dto.legalEntityId,
        lines: dto.lines,
      });
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
  }

  @Post('journals/:id/reverse') async reverse(@Param('id') id: string, @Body() dto: ReverseDto) {
    try {
      return await this.posting.reverse(id, dto.reason);
    } catch (e) {
      if (e instanceof FinanceError) throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
  }

  @Get('trial-balance') async trialBalance(@Query('asOf') asOf?: string) {
    const date = asOf ? day(asOf) : undefined;
    const [accounts, sums] = await Promise.all([
      this.prisma.db.chartAccount.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.db.journalLine.groupBy({
        by: ['accountId'],
        where: date ? { journal: { postingDate: { lte: date } } } : {},
        _sum: { debit: true, credit: true },
      }),
    ]);
    const m = new Map(sums.map((s) => [s.accountId, s._sum]));
    const rows = accounts
      .map((a) => {
        const s = m.get(a.id);
        const debit = money(s?.debit ?? 0);
        const credit = money(s?.credit ?? 0);
        return { code: a.code, name: a.name, type: a.type, debit: debit.toString(), credit: credit.toString(), balance: debit.minus(credit).toString() };
      })
      .filter((r) => r.debit !== '0' || r.credit !== '0');
    const totalDebit = rows.reduce((s, r) => s.plus(r.debit), d(0));
    const totalCredit = rows.reduce((s, r) => s.plus(r.credit), d(0));
    return { rows, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), balanced: totalDebit.equals(totalCredit) };
  }

  // Phase 2 exit criterion: stock valuation must equal the ledger.
  @Get('reconciliation/inventory') async inventoryReconciliation() {
    const stock = await this.prisma.db.stockBalance.aggregate({ _sum: { value: true } });
    const gl = await this.posting.balance('INVENTORY');
    const stockValue = money(stock._sum.value ?? 0);
    return { stockValue: stockValue.toString(), ledgerBalance: money(gl).toString(), difference: stockValue.minus(money(gl)).toString(), reconciled: stockValue.equals(money(gl)) };
  }
}

@Global()
@Module({ controllers: [FinanceController], providers: [FinancePostingService], exports: [FinancePostingService] })
export class FinanceModule {}
