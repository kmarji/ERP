import { Body, Controller, Get, Header, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsOptional, IsString, MinLength } from 'class-validator';
import { money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/time';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { requireStub } from '../integrations/adapter-mode';
import { EInvoiceAdapter, StubEInvoiceAdapter } from './einvoice';
import { EInvoicingService } from './einvoicing.service';
import { StubTaxFilingAdapter, TaxFilingAdapter } from './tax.adapters';
import { TaxReturnsService } from './tax-returns.service';

class PeriodDto {
  @IsString() legalEntityId!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() label?: string;
}

class AckDto {
  @IsString() code!: string;
  @IsString() @MinLength(5) reason!: string;
}

class ReviewDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() comment?: string;
}

class FilingDto {
  @IsString() @MinLength(3) acknowledgmentRef!: string;
  @IsOptional() @IsDateString() filedAt?: string;
  @IsOptional() @IsString() evidenceDocumentId?: string;
}

class PaymentDto {
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsDateString() paidAt?: string;
}

class EInvoiceSettingDto {
  @IsBoolean() enabled!: boolean;
}

@ApiTags('tax')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE')
@Controller('tax')
class TaxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly returns: TaxReturnsService,
    private readonly einvoicing: EInvoicingService,
  ) {}

  // Input-tax evidence collected from posted supplier invoices.
  @Get('input-summary') async inputSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.summary('INPUT', from, to);
  }

  @Get('output-summary') async outputSummary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.summary('OUTPUT', from, to);
  }

  private async summary(direction: 'INPUT' | 'OUTPUT', from?: string, to?: string) {
    const where = { direction, documentDate: { ...(from ? { gte: dateOnly(from) } : {}), ...(to ? { lte: dateOnly(to) } : {}) } };
    const rows = await this.prisma.db.taxLedgerEntry.groupBy({ by: ['taxRate', 'eligible'], where, _sum: { base: true, taxAmount: true }, _count: true });
    const lines = rows.map((r) => ({ taxRate: r.taxRate.toString(), eligible: r.eligible, base: money(r._sum.base ?? 0).toString(), tax: money(r._sum.taxAmount ?? 0).toString(), documents: r._count }));
    const sum = (eligible: boolean) => money(rows.filter((r) => r.eligible === eligible).reduce((s, r) => s.plus(r._sum.taxAmount ?? 0), money(0))).toString();
    return direction === 'INPUT' ? { lines, recoverableInputTax: sum(true), nonRecoverableInputTax: sum(false) } : { lines, outputTax: sum(true) };
  }

  @Get('periods') periods() {
    return this.returns.listPeriods();
  }

  @Post('periods') createPeriod(@Body() dto: PeriodDto) {
    return this.returns.createPeriod(dto);
  }

  @Get('returns') list(@Query('periodId') periodId?: string) {
    return this.returns.list(periodId);
  }

  @Post('periods/:id/generate') generate(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.returns.generate(id, u);
  }

  @Get('returns/:id') one(@Param('id') id: string) {
    return this.returns.get(id);
  }

  @Get('returns/:id/working-papers.csv') @Header('Content-Type', 'text/csv') csv(@Param('id') id: string) {
    return this.returns.workingPapersCsv(id);
  }

  @Get('returns/:id/evidence') evidence(@Param('id') id: string) {
    return this.returns.evidence(id);
  }

  @Roles('FINANCE') @Post('returns/:id/acknowledge') ack(@Param('id') id: string, @Body() dto: AckDto, @CurrentUser() u: RequestUser) {
    return this.returns.acknowledge(id, dto, u);
  }

  @Roles('FINANCE') @Post('returns/:id/submit-review') submit(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.returns.submitForReview(id, u);
  }

  @Roles('FINANCE') @Post('returns/:id/review') review(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() u: RequestUser) {
    return this.returns.review(id, dto, u);
  }

  @Post('returns/:id/package') pkg(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.returns.preparePackage(id, u);
  }

  @Post('returns/:id/record-filing') filing(@Param('id') id: string, @Body() dto: FilingDto, @CurrentUser() u: RequestUser) {
    return this.returns.recordFiling(id, dto, u);
  }

  @Post('returns/:id/record-payment') payment(@Param('id') id: string, @Body() dto: PaymentDto, @CurrentUser() u: RequestUser) {
    return this.returns.recordPayment(id, dto, u);
  }

  @Post('returns/:id/archive') archive(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.returns.archive(id, u);
  }

  @Get('settings/einvoicing') einvoiceSettings() {
    return this.einvoicing.settings();
  }

  @Roles('OWNER') @Put('settings/einvoicing') setEinvoice(@Body() dto: EInvoiceSettingDto) {
    return this.einvoicing.setEnabled(dto.enabled);
  }

  @Get('einvoices') einvoices(@Query('status') status?: string) {
    return this.einvoicing.list(status);
  }

  @Post('einvoices/:id/resubmit') resubmit(@Param('id') id: string) {
    return this.einvoicing.resubmit(id);
  }
}

@Module({
  controllers: [TaxController],
  providers: [
    TaxReturnsService,
    EInvoicingService,
    {
      provide: TaxFilingAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'TAX_FILING');
        return new StubTaxFilingAdapter();
      },
    },
    {
      provide: EInvoiceAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'EINVOICE');
        return new StubEInvoiceAdapter();
      },
    },
  ],
  exports: [TaxReturnsService],
})
export class TaxModule {}
