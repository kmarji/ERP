import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { DocumentsService } from '../documents/documents.module';
import { LeaveService } from './leave.service';
import { SchedulesService } from './schedules.service';
import { TimeService } from './time.service';
import { employeeOf, MANAGERS } from './common';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class TemplateDto {
  @IsOptional() @IsString() branchId?: string;
  @IsString() @MinLength(2) name!: string;
  @Matches(HHMM) startTime!: string;
  @Matches(HHMM) endTime!: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) breakMinutes?: number;
}
class TemplatePatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @Matches(HHMM) startTime?: string;
  @IsOptional() @Matches(HHMM) endTime?: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) breakMinutes?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ShiftDto {
  @IsString() employeeId!: string;
  @IsString() branchId!: string;
  @IsDateString() date!: string;
  @IsOptional() @IsString() templateId?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsDateString() endAt?: string;
  @IsOptional() @IsString() notes?: string;
}
class BulkDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ShiftDto) shifts!: ShiftDto[];
}
class SwapDto {
  @IsString() scheduleId!: string;
  @IsString() toEmployeeId!: string;
  @IsOptional() @IsString() reason?: string;
}
class DecideDto {
  @IsBoolean() approve!: boolean;
}
class ClockInDto {
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsDateString() at?: string;
}
class ClockOutDto {
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsDateString() at?: string;
}
class ManualDto {
  @IsString() employeeId!: string;
  @IsString() branchId!: string;
  @IsDateString() clockIn!: string;
  @IsDateString() clockOut!: string;
  @IsOptional() @IsString() note?: string;
}
class CorrectDto {
  @IsDateString() clockIn!: string;
  @IsDateString() clockOut!: string;
  @IsString() @MinLength(3) note!: string;
}
class PeriodDto {
  @IsString() branchId!: string;
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}
class LeaveDto {
  @IsOptional() @IsString() employeeId?: string;
  @IsString() leaveTypeId!: string;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() certificateDocId?: string;
}

@ApiTags('workforce')
@ApiBearerAuth()
@Controller()
export class WorkforceController {
  constructor(private readonly schedules: SchedulesService, private readonly time: TimeService, private readonly leave: LeaveService) {}

  // ---- schedules
  @Roles(...MANAGERS) @Get('shift-templates') templates(@Query('branchId') b?: string) { return this.schedules.listTemplates(b); }
  @Roles(...MANAGERS) @Post('shift-templates') createTemplate(@Body() dto: TemplateDto, @CurrentUser() u: RequestUser) { return this.schedules.createTemplate(dto, u); }
  @Roles(...MANAGERS) @Patch('shift-templates/:id') patchTemplate(@Param('id') id: string, @Body() dto: TemplatePatchDto, @CurrentUser() u: RequestUser) { return this.schedules.patchTemplate(id, dto, u); }
  @Roles(...MANAGERS) @Get('schedules') listSchedules(@Query() q: { branchId?: string; employeeId?: string; from?: string; to?: string }) { return this.schedules.list(q); }
  @Roles(...MANAGERS) @Post('schedules') createShift(@Body() dto: ShiftDto, @CurrentUser() u: RequestUser) { return this.schedules.create(dto, u); }
  @Roles(...MANAGERS) @Post('schedules/bulk') bulk(@Body() dto: BulkDto, @CurrentUser() u: RequestUser) { return this.schedules.bulk(dto.shifts, u); }
  @Roles(...MANAGERS) @Post('schedules/:id/cancel') cancelShift(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.schedules.cancel(id, u); }
  @Roles(...MANAGERS) @Get('shift-swaps') swaps(@Query('status') s?: string) { return this.schedules.listSwaps(s); }
  @Roles(...MANAGERS) @Post('shift-swaps/:id/decide') decideSwap(@Param('id') id: string, @Body() dto: DecideDto, @CurrentUser() u: RequestUser) { return this.schedules.decideSwap(id, dto.approve, u); }

  // ---- time (kiosk: a manager punches for an employee)
  @Roles(...MANAGERS) @Post('time/kiosk/clock-in') kioskIn(@Body() dto: ClockInDto, @CurrentUser() u: RequestUser) { return this.time.clockIn(u, dto); }
  @Roles(...MANAGERS) @Post('time/kiosk/clock-out') kioskOut(@Body() dto: ClockOutDto, @CurrentUser() u: RequestUser) { return this.time.clockOut(u, dto); }
  @Roles(...MANAGERS) @Get('time-entries') entries(@Query() q: { employeeId?: string; branchId?: string; from?: string; to?: string; status?: string }) { return this.time.list(q); }
  @Roles(...MANAGERS) @Post('time-entries/manual') manual(@Body() dto: ManualDto, @CurrentUser() u: RequestUser) { return this.time.manual(dto, u); }
  @Roles(...MANAGERS) @Post('time-entries/approve-period') approvePeriod(@Body() dto: PeriodDto, @CurrentUser() u: RequestUser) { return this.time.approvePeriod(dto, u); }
  @Roles(...MANAGERS) @Post('time-entries/:id/approve') approve(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.time.approve(id, u); }
  @Roles(...MANAGERS) @Post('time-entries/flag-missing') flag() { return this.time.flagMissingPunches().then((flagged) => ({ flagged })); }

  // ---- leave (HR / managers)
  @Roles(...MANAGERS) @Get('leave/types') leaveTypes() { return this.leave.types(); }
  @Roles('OWNER', 'HR') @Post('leave/accrue') accrue() { return this.leave.accrue(); }
  @Roles(...MANAGERS) @Get('leave/requests') leaveRequests(@Query() q: { employeeId?: string; status?: string; from?: string; to?: string }) { return this.leave.list(q); }
  @Roles(...MANAGERS) @Get('leave/balances/:employeeId') leaveBalances(@Param('employeeId') id: string) { return this.leave.balances(id); }
  @Roles(...MANAGERS) @Post('leave/requests') leaveForEmployee(@Body() dto: LeaveDto, @CurrentUser() u: RequestUser) { return this.leave.request(u, dto); }
  @Roles(...MANAGERS) @Post('leave/requests/:id/cancel') leaveCancel(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.leave.cancel(id, u); }
}

// Employee self-service: every route works on the caller's own linked Employee, 404 without one.
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class SelfServiceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: SchedulesService,
    private readonly time: TimeService,
    private readonly leave: LeaveService,
    private readonly docs: DocumentsService,
  ) {}

  @Get('profile') async profile(@CurrentUser() u: RequestUser) {
    const e = await employeeOf(this.prisma, u);
    const assignments = await this.prisma.db.employeeAssignment.findMany({ where: { employeeId: e.id } });
    return { id: e.id, number: e.number, name: e.name, hireDate: e.hireDate, status: e.status, assignments };
  }

  @Get('schedule') async schedule(@CurrentUser() u: RequestUser, @Query() q: { from?: string; to?: string }) {
    return this.schedules.list({ employeeId: (await employeeOf(this.prisma, u)).id, ...q });
  }

  @Get('time') async myTime(@CurrentUser() u: RequestUser, @Query() q: { from?: string; to?: string }) {
    return this.time.list({ employeeId: (await employeeOf(this.prisma, u)).id, ...q });
  }

  @Post('clock-in') clockIn(@CurrentUser() u: RequestUser, @Body() dto: ClockInDto) { return this.time.clockIn(u, { branchId: dto.branchId }); }
  @Post('clock-out') clockOut(@CurrentUser() u: RequestUser) { return this.time.clockOut(u, {}); }
  @Post('time/:id/correct') correct(@Param('id') id: string, @Body() dto: CorrectDto, @CurrentUser() u: RequestUser) { return this.time.correct(id, dto, u); }

  @Get('leave/balances') async balances(@CurrentUser() u: RequestUser) { return this.leave.balances((await employeeOf(this.prisma, u)).id); }
  @Get('leave/requests') async requests(@CurrentUser() u: RequestUser) { return this.leave.list({ employeeId: (await employeeOf(this.prisma, u)).id }); }
  @Post('leave/requests') request(@CurrentUser() u: RequestUser, @Body() dto: LeaveDto) { return this.leave.request(u, { ...dto, employeeId: undefined }); }
  @Post('leave/requests/:id/cancel') cancelLeave(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.leave.cancel(id, u); }

  @Get('swaps') async swaps(@CurrentUser() u: RequestUser) { return this.schedules.mySwaps((await employeeOf(this.prisma, u)).id); }
  @Post('swaps') swap(@Body() dto: SwapDto, @CurrentUser() u: RequestUser) { return this.schedules.requestSwap(dto, u); }

  @Get('payslips') async payslips(@CurrentUser() u: RequestUser) {
    const e = await employeeOf(this.prisma, u);
    const lines = await this.prisma.db.payrollRunLine.findMany({ where: { employeeId: e.id, run: { status: { in: ['FINALIZED', 'PAID'] } } }, include: { run: true }, orderBy: { run: { periodStart: 'desc' } }, take: 36 });
    return lines.map((l) => ({ lineId: l.id, runNumber: l.run.number, periodStart: l.run.periodStart, periodEnd: l.run.periodEnd, gross: l.gross, net: l.net, hasPayslip: !!l.payslipDocId }));
  }

  @Get('payslips/:lineId/download') async payslip(@Param('lineId') lineId: string, @CurrentUser() u: RequestUser, @Res() res: any) {
    const e = await employeeOf(this.prisma, u);
    const line = await this.prisma.db.payrollRunLine.findFirst({ where: { id: lineId, employeeId: e.id, run: { status: { in: ['FINALIZED', 'PAID'] } } } });
    if (!line?.payslipDocId) throw new NotFoundException('Payslip not found');
    const { doc, data } = await this.docs.read(line.payslipDocId);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`);
    res.send(data);
  }

  @Get('training') async training(@CurrentUser() u: RequestUser) {
    return this.prisma.db.trainingAssignment.findMany({ where: { employeeId: (await employeeOf(this.prisma, u)).id } });
  }
}
