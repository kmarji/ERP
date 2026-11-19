import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { MANAGERS } from '../workforce/common';
import { ActionsService } from './actions.service';
import { AuditsService } from './audits.service';
import { DashboardService } from './dashboard.service';
import { FoodSafetyService } from './food-safety.service';
import { ReportsService } from './reports.service';

class AuditItemDto {
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsNumber() @Min(0.1) @Max(100) weight?: number;
  @IsOptional() @IsBoolean() critical?: boolean;
  @IsOptional() @IsBoolean() evidenceRequired?: boolean;
}
class AuditTemplateDto {
  @IsOptional() @IsString() code?: string;
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) passPercent?: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AuditItemDto) items!: AuditItemDto[];
}
class StartAuditDto { @IsString() templateId!: string; @IsString() branchId!: string; }
class AnswerDto {
  @IsString() itemId!: string;
  @IsIn(['PASS', 'FAIL', 'NA']) result!: 'PASS' | 'FAIL' | 'NA';
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() docId?: string;
}
class CompleteAuditDto { @IsArray() @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[]; }

class PointDto {
  @IsOptional() @IsString() id?: string;
  @IsString() branchId!: string;
  @IsString() @MinLength(2) name!: string;
  @IsIn(['FRIDGE', 'FREEZER', 'HOT_HOLD', 'COOKING', 'OTHER']) kind!: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() minValue?: number | null;
  @IsOptional() @IsNumber() maxValue?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ReadingDto {
  @IsString() pointId!: string;
  @IsNumber() value!: number;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() docId?: string;
}

class ActionDto {
  @IsString() branchId!: string;
  @IsString() @MinLength(3) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) severity!: string;
  @IsOptional() @IsDateString() dueAt?: string;
}
class AssignActionDto { @IsString() employeeId!: string; @IsOptional() @IsDateString() dueAt?: string; }
class VerifyDto { @IsBoolean() approve!: boolean; @IsOptional() @IsString() note?: string; }
class ReasonDto { @IsString() @MinLength(3) reason!: string; }
class CompleteActionDto { @IsString() @MinLength(3) note!: string; @IsArray() @IsString({ each: true }) docIds!: string[]; }

@ApiTags('operations')
@ApiBearerAuth()
@Controller('ops')
export class AuditsController {
  constructor(private readonly audits: AuditsService, private readonly food: FoodSafetyService, private readonly actions: ActionsService) {}

  @Roles(...MANAGERS) @Get('audit-templates') templates(@CurrentUser() u: RequestUser, @Query('all') all?: string) { return this.audits.templates(u, all === '1'); }
  @Roles(...MANAGERS) @Post('audit-templates') saveTemplate(@Body() dto: AuditTemplateDto, @CurrentUser() u: RequestUser) { return this.audits.saveTemplate(dto, u); }
  @Roles(...MANAGERS) @Get('audits') list(@Query() q: { branchId?: string; status?: string }, @CurrentUser() u: RequestUser) { return this.audits.list(q, u); }
  @Roles(...MANAGERS) @Post('audits') start(@Body() dto: StartAuditDto, @CurrentUser() u: RequestUser) { return this.audits.start(dto, u); }
  @Roles(...MANAGERS) @Get('audits/:id') get(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.audits.get(id, u); }
  @Roles(...MANAGERS) @Post('audits/:id/complete') complete(@Param('id') id: string, @Body() dto: CompleteAuditDto, @CurrentUser() u: RequestUser) { return this.audits.complete(id, dto.answers, u); }

  @Roles(...MANAGERS) @Get('food-safety/points') points(@CurrentUser() u: RequestUser, @Query('branchId') b?: string) { return this.food.points(u, b); }
  @Roles(...MANAGERS) @Post('food-safety/points') savePoint(@Body() dto: PointDto, @CurrentUser() u: RequestUser) { return this.food.savePoint(dto, u); }
  @Roles(...MANAGERS) @Get('food-safety/readings') readings(@Query() q: { branchId?: string; pointId?: string; from?: string; outOfRange?: string }, @CurrentUser() u: RequestUser) { return this.food.readings(q, u); }
  @Roles(...MANAGERS) @Post('food-safety/readings') record(@Body() dto: ReadingDto, @CurrentUser() u: RequestUser) { return this.food.record(dto, u, 'manager'); }

  @Roles(...MANAGERS) @Get('actions') actionList(@Query() q: { branchId?: string; status?: string; source?: string }, @CurrentUser() u: RequestUser) { return this.actions.list(q, u); }
  @Roles(...MANAGERS) @Post('actions') actionCreate(@Body() dto: ActionDto, @CurrentUser() u: RequestUser) { return this.actions.manual(dto, u); }
  @Roles(...MANAGERS) @Get('actions/:id') actionGet(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.actions.get(id, u); }
  @Roles(...MANAGERS) @Post('actions/:id/assign') assign(@Param('id') id: string, @Body() dto: AssignActionDto, @CurrentUser() u: RequestUser) { return this.actions.assign(id, dto, u); }
  @Roles(...MANAGERS) @Post('actions/:id/verify') verify(@Param('id') id: string, @Body() dto: VerifyDto, @CurrentUser() u: RequestUser) { return this.actions.verify(id, dto, u); }
  @Roles(...MANAGERS) @Post('actions/:id/cancel') cancel(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) { return this.actions.cancel(id, dto.reason, u); }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MySafetyController {
  constructor(private readonly food: FoodSafetyService, private readonly actions: ActionsService) {}

  @Get('food-safety/points') points(@CurrentUser() u: RequestUser) { return this.food.myPoints(u); }
  @Post('food-safety/readings') record(@Body() dto: ReadingDto, @CurrentUser() u: RequestUser) { return this.food.record(dto, u, 'employee'); }
  @Get('actions') mine(@CurrentUser() u: RequestUser) { return this.actions.mine(u); }
  @Post('actions/:id/complete') complete(@Param('id') id: string, @Body() dto: CompleteActionDto, @CurrentUser() u: RequestUser) { return this.actions.complete(id, dto, u); }
}

// A47 dashboard and A60 reports
@ApiTags('operations')
@ApiBearerAuth()
@Controller('ops')
export class OpsOverviewController {
  constructor(private readonly dash: DashboardService, private readonly reports: ReportsService) {}

  @Roles(...MANAGERS) @Get('dashboard') dashboard(@CurrentUser() u: RequestUser, @Query('branchId') b?: string) { return this.dash.dashboard(u, b); }

  @Roles(...MANAGERS) @Get('reports/:kind')
  async report(@Param('kind') kind: string, @Query() q: { branchId?: string; from?: string; to?: string; format?: string }, @CurrentUser() u: RequestUser, @Res({ passthrough: true }) res: any) {
    const rows = await this.reports.rows(kind, q, u);
    if (q.format !== 'csv') return rows;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-report.csv"`);
    return this.reports.csv(rows);
  }
}
