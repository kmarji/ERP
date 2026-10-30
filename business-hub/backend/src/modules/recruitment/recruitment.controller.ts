import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { ApplicationsService, REJECTION_REASONS } from './applications.service';
import { RetentionService } from './retention.service';
import { RecruitmentSetupService } from './setup.service';
import { VacanciesService } from './vacancies.service';

class TrainingModuleDto {
  @IsString() title!: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
  @IsOptional() @IsInt() @Min(0) dueDays?: number;
}

class PositionDto {
  @IsString() @MinLength(2) title!: string;
  @IsOptional() @IsString() titleAr?: string;
  @IsNumber() @Min(0) payBandMin!: number;
  @IsNumber() @Min(0) payBandMax!: number;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredSkills?: string[];
  @IsOptional() @IsArray() @IsObject({ each: true }) eligibilityCriteria?: Record<string, unknown>[];
  @IsOptional() @IsString() interviewTemplateId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredDocuments?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TrainingModuleDto) trainingModules?: TrainingModuleDto[];
}

class PositionPatchDto {
  @IsOptional() @IsString() titleAr?: string;
  @IsOptional() @IsNumber() @Min(0) payBandMin?: number;
  @IsOptional() @IsNumber() @Min(0) payBandMax?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredSkills?: string[];
  @IsOptional() @IsArray() @IsObject({ each: true }) eligibilityCriteria?: Record<string, unknown>[];
  @IsOptional() @IsString() interviewTemplateId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) requiredDocuments?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TrainingModuleDto) trainingModules?: TrainingModuleDto[];
  @IsOptional() @IsBoolean() active?: boolean;
}

class TemplateDto {
  @IsString() name!: string;
  @IsIn(['en', 'ar']) language!: 'en' | 'ar';
  @IsArray() @IsObject({ each: true }) questions!: Record<string, unknown>[];
  @IsObject() rubric!: Record<string, unknown>;
}

class BudgetDto {
  @IsString() branchId!: string;
  @IsString() positionId!: string;
  @IsInt() @Min(0) approved!: number;
}

class VacancyDto {
  @IsString() branchId!: string;
  @IsString() positionId!: string;
  @IsInt() @Min(1) @Max(100) headcount!: number;
  @IsOptional() @IsNumber() @Min(0) payMin?: number;
  @IsOptional() @IsNumber() @Min(0) payMax?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsDateString() closesAt?: string;
  @IsOptional() @IsIn(['en', 'ar']) language?: 'en' | 'ar';
}

class DecisionDto {
  @IsIn(['advance', 'reject', 'invite', 'reinvite', 'confirm_screening_reject', 'override_screening']) action!: 'advance' | 'reject' | 'invite' | 'reinvite' | 'confirm_screening_reject' | 'override_screening';
  @IsOptional() @IsIn(Object.keys(REJECTION_REASONS)) reason?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class ResolveAppealDto {
  @IsIn(['UPHELD', 'OVERTURNED']) outcome!: 'UPHELD' | 'OVERTURNED';
  @IsString() @MinLength(5) resolution!: string;
}

class LangDto {
  @IsOptional() @IsIn(['en', 'ar']) language?: 'en' | 'ar';
}

const HR = ['OWNER', 'HR'];
const RECRUITERS = ['OWNER', 'HR', 'BRANCH_MANAGER'];

@ApiTags('recruitment')
@ApiBearerAuth()
@Controller('recruitment')
export class RecruitmentController {
  constructor(
    private readonly setup: RecruitmentSetupService,
    private readonly vacancies: VacanciesService,
    private readonly applications: ApplicationsService,
    private readonly retention: RetentionService,
  ) {}

  @Roles(...RECRUITERS) @Get('positions') positions() {
    return this.setup.listPositions();
  }

  @Roles(...HR) @Post('positions') createPosition(@Body() dto: PositionDto) {
    return this.setup.createPosition(dto);
  }

  @Roles(...HR) @Patch('positions/:id') patchPosition(@Param('id') id: string, @Body() dto: PositionPatchDto) {
    return this.setup.patchPosition(id, dto);
  }

  @Roles(...HR) @Get('interview-templates') templates() {
    return this.setup.listTemplates();
  }

  @Roles(...HR) @Post('interview-templates') createTemplate(@Body() dto: TemplateDto) {
    return this.setup.createTemplate(dto);
  }

  @Roles(...HR) @Post('interview-templates/default') defaultTemplate(@Body() dto: LangDto) {
    return this.setup.createDefaultTemplate(dto.language ?? 'en');
  }

  @Roles(...HR, 'FINANCE') @Get('budgets') budgets() {
    return this.setup.listBudgets();
  }

  @Roles(...HR, 'FINANCE') @Put('budgets') setBudget(@Body() dto: BudgetDto) {
    return this.setup.setBudget(dto);
  }

  @Roles(...RECRUITERS) @Get('vacancies') vacancyList(@Query('branchId') branchId?: string, @Query('status') status?: string) {
    return this.vacancies.list({ branchId, status });
  }

  @Roles(...RECRUITERS) @Post('vacancies') createVacancy(@Body() dto: VacancyDto, @CurrentUser() u: RequestUser) {
    return this.vacancies.create(dto, u);
  }

  @Roles(...RECRUITERS) @Get('vacancies/:id') vacancy(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.vacancies.get(id, u);
  }

  @Roles(...RECRUITERS) @Post('vacancies/:id/close') close(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.vacancies.close(id, u, 'CLOSED');
  }

  @Roles(...RECRUITERS) @Post('vacancies/:id/cancel') cancel(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.vacancies.close(id, u, 'CANCELLED');
  }

  @Roles(...RECRUITERS) @Get('applications') applicationList(@Query('vacancyId') vacancyId: string | undefined, @Query('status') status: string | undefined, @CurrentUser() u: RequestUser) {
    return this.applications.list({ vacancyId, status }, u);
  }

  @Roles(...RECRUITERS) @Get('applications/:id') application(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.applications.get(id, u);
  }

  @Roles(...RECRUITERS) @Post('applications/:id/decision') decide(@Param('id') id: string, @Body() dto: DecisionDto, @CurrentUser() u: RequestUser) {
    return this.applications.decide(id, dto, u);
  }

  @Roles(...RECRUITERS) @Get('interviews/:id/transcript') transcript(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.applications.transcript(id, u);
  }

  @Roles(...HR) @Get('appeals') appeals(@Query('status') status?: string) {
    return this.applications.listAppeals(status);
  }

  @Roles(...HR) @Post('appeals/:id/resolve') resolve(@Param('id') id: string, @Body() dto: ResolveAppealDto, @CurrentUser() u: RequestUser) {
    return this.applications.resolveAppeal(id, dto, u);
  }

  @Roles(...HR) @Post('retention/sweep') sweep() {
    return this.retention.sweep().then((anonymized) => ({ anonymized }));
  }
}
