import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PayrollRulesService } from './payroll-rules.service';
import { PayrollService } from './payroll.service';

class RunDto {
  @IsString() legalEntityId!: string;
  @IsDateString() periodStart!: string;
  @IsDateString() periodEnd!: string;
}
class ExceptionDto {
  @IsIn(['ACKNOWLEDGE', 'RESOLVE']) action!: 'ACKNOWLEDGE' | 'RESOLVE';
  @IsString() @MinLength(3) note!: string;
}
class ReviewDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() comment?: string;
}
class PaymentDto {
  @IsString() @MinLength(2) reference!: string;
  @IsOptional() @IsIn(['BANK', 'CASH']) method?: 'BANK' | 'CASH';
  @IsOptional() @IsDateString() paidAt?: string;
}
class ObligationPayDto {
  @IsString() @MinLength(2) reference!: string;
  @IsOptional() @IsDateString() paidAt?: string;
}
class AdvanceDto {
  @IsString() employeeId!: string;
  @IsNumber() @Min(0.001) amount!: number;
  @IsInt() @Min(1) @Max(36) installments!: number;
  @IsOptional() @IsString() reason?: string;
}
class AdjustmentDto {
  @IsString() employeeId!: string;
  @IsIn(['EARNING', 'DEDUCTION']) kind!: 'EARNING' | 'DEDUCTION';
  @IsString() @MinLength(2) label!: string;
  @IsNumber() @Min(0.001) amount!: number;
}
class RuleSetDto {
  @IsDateString() effectiveFrom!: string;
  @IsObject() rules!: Record<string, unknown>;
  @IsOptional() @IsString() notes?: string;
}
class VerifyDto {
  @IsString() @MinLength(5) note!: string;
}

const HR = ['OWNER', 'HR'];
const HR_FIN = ['OWNER', 'HR', 'FINANCE'];
const FIN = ['OWNER', 'FINANCE'];

@ApiTags('payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService, private readonly rules: PayrollRulesService) {}

  @Roles(...HR_FIN) @Get('runs') runs() { return this.payroll.list(); }
  @Roles(...HR) @Post('runs') create(@Body() dto: RunDto, @CurrentUser() u: RequestUser) { return this.payroll.createRun(dto, u); }
  @Roles(...HR_FIN) @Get('runs/:id') get(@Param('id') id: string) { return this.payroll.get(id); }
  @Roles(...HR) @Post('runs/:id/calculate') calculate(@Param('id') id: string) { return this.payroll.calculate(id); }
  @Roles(...HR) @Post('runs/:id/submit-review') submit(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.payroll.submitReview(id, u); }
  @Roles(...FIN) @Post('runs/:id/review') review(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() u: RequestUser) { return this.payroll.review(id, dto, u); }
  @Roles(...HR) @Post('runs/:id/cancel') cancel(@Param('id') id: string) { return this.payroll.cancel(id); }
  @Roles(...FIN) @Post('runs/:id/payslips') payslips(@Param('id') id: string) { return this.payroll.generatePayslips(id); }
  @Roles(...HR) @Post('exceptions/:id/resolve') resolve(@Param('id') id: string, @Body() dto: ExceptionDto, @CurrentUser() u: RequestUser) { return this.payroll.resolveException(id, dto, u); }

  @Roles(...FIN) @Post('runs/:id/bank-file') @Header('Cache-Control', 'no-store')
  bank(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.payroll.bankFile(id, u); }
  @Roles(...FIN) @Post('runs/:id/request-payment') requestPayment(@Param('id') id: string) { return this.payroll.requestPayment(id); }
  @Roles(...FIN) @Post('runs/:id/confirm-payment') confirm(@Param('id') id: string, @Body() dto: PaymentDto, @CurrentUser() u: RequestUser) { return this.payroll.confirmPayment(id, dto, u); }

  @Roles(...FIN) @Get('obligations') obligations(@Query('status') status?: string) { return this.payroll.listObligations(status); }
  @Roles(...FIN) @Post('obligations/:id/pay') payObligation(@Param('id') id: string, @Body() dto: ObligationPayDto, @CurrentUser() u: RequestUser) { return this.payroll.payObligation(id, dto, u); }

  @Roles(...HR_FIN) @Get('advances') advances(@Query('employeeId') e?: string) { return this.payroll.listAdvances(e); }
  @Roles(...HR) @Post('advances') advance(@Body() dto: AdvanceDto, @CurrentUser() u: RequestUser) { return this.payroll.issueAdvance(dto, u); }
  @Roles(...HR_FIN) @Get('adjustments') adjustments(@Query('applied') a?: string) { return this.payroll.listAdjustments(a === undefined ? undefined : a === 'true'); }
  @Roles(...HR) @Post('adjustments') adjust(@Body() dto: AdjustmentDto, @CurrentUser() u: RequestUser) { return this.payroll.addAdjustment(dto, u); }

  @Roles(...HR_FIN) @Get('rules') ruleSets() { return this.rules.list(); }
  @Roles(...HR) @Post('rules') createRules(@Body() dto: RuleSetDto, @CurrentUser() u: RequestUser) { return this.rules.create(dto, u); }
  @Roles(...FIN) @Post('rules/:id/activate') activate(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.rules.activate(id, u); }
  @Roles(...FIN) @Post('rules/:id/verify') verify(@Param('id') id: string, @Body() dto: VerifyDto, @CurrentUser() u: RequestUser) { return this.rules.verify(id, dto.note, u); }
}
