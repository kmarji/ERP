import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, Max, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { employeeOf, MANAGERS } from '../workforce/common';
import { DisciplineService } from './discipline.service';

class ReportDto {
  @IsString() employeeId!: string;
  @IsString() category!: string;
  @IsString() @MinLength(5) description!: string;
  @IsDateString() incidentDate!: string;
  @IsOptional() @IsArray() evidenceDocIds?: string[];
}
class DecideDto {
  @IsString() sanction!: string; // an action key from the company's ladder, or NONE to dismiss
  @IsOptional() @IsNumber() @Min(0.001) fineAmount?: number;
  @IsOptional() @IsString() legalBasis?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}
class CategoryDto {
  @IsString() @MinLength(2) key!: string;
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) expiryMonths?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class ActionDto {
  @IsString() @MinLength(2) key!: string;
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) step?: number;
  @IsOptional() @IsBoolean() countsAsWarning?: boolean;
  @IsOptional() @IsNumber() @Min(0) defaultDeduction?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
class TextDto { @IsString() @MinLength(3) text!: string; }
class AppealDecisionDto { @IsIn(['UPHELD', 'OVERTURNED']) outcome!: 'UPHELD' | 'OVERTURNED'; }

const HR = ['OWNER', 'HR'];

@ApiTags('discipline')
@ApiBearerAuth()
@Controller('discipline')
export class DisciplineController {
  constructor(private readonly svc: DisciplineService) {}

  @Roles(...MANAGERS) @Get('categories') categories(@Query('all') all?: string) { return this.svc.categories(all === '1'); }
  @Roles(...HR) @Post('categories') saveCategory(@Body() dto: CategoryDto) { return this.svc.saveCategory(dto); }
  @Roles(...MANAGERS) @Get('actions') actions(@Query('all') all?: string) { return this.svc.actions(all === '1'); }
  @Roles(...HR) @Post('actions') saveAction(@Body() dto: ActionDto) { return this.svc.saveAction(dto); }
  @Roles(...HR) @Get('suggest') suggest(@Query('employeeId') employeeId: string) { return this.svc.suggest(employeeId); }
  @Roles(...HR) @Get('cases') list(@Query() q: { employeeId?: string; status?: string }) { return this.svc.list(q); }
  @Roles(...HR) @Get('cases/:id') get(@Param('id') id: string) { return this.svc.get(id); }
  @Roles(...MANAGERS) @Post('cases') report(@Body() dto: ReportDto, @CurrentUser() u: RequestUser) { return this.svc.report(dto, u); }
  @Roles(...HR) @Post('cases/:id/review') review(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.startReview(id, u); }
  @Roles(...HR) @Post('cases/:id/request-response') ask(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.requestResponse(id, u); }
  @Roles(...HR) @Post('cases/:id/decide') decide(@Param('id') id: string, @Body() dto: DecideDto, @CurrentUser() u: RequestUser) { return this.svc.decide(id, dto, u); }
  @Roles(...HR) @Post('cases/:id/notify') notify(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.notify(id, u); }
  @Roles(...HR) @Post('cases/:id/appeal-decision') appeal(@Param('id') id: string, @Body() dto: AppealDecisionDto, @CurrentUser() u: RequestUser) { return this.svc.decideAppeal(id, dto.outcome, u); }
  @Roles(...HR) @Post('cases/:id/close') close(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.close(id, u); }
}

// E10 My Warnings
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/warnings')
export class MyWarningsController {
  constructor(private readonly prisma: PrismaService, private readonly svc: DisciplineService) {}

  @Get() async list(@CurrentUser() u: RequestUser) { return this.svc.mine((await employeeOf(this.prisma, u)).id); }
  @Post(':id/respond') async respond(@Param('id') id: string, @Body() dto: TextDto, @CurrentUser() u: RequestUser) { return this.svc.respond(id, (await employeeOf(this.prisma, u)).id, dto.text); }
  @Post(':id/acknowledge') async ack(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.acknowledge(id, (await employeeOf(this.prisma, u)).id); }
  @Post(':id/appeal') async appeal(@Param('id') id: string, @Body() dto: TextDto, @CurrentUser() u: RequestUser) { return this.svc.appeal(id, (await employeeOf(this.prisma, u)).id, dto.text); }
}
