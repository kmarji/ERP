import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { MANAGERS } from '../workforce/common';
import { ChecklistsService } from './checklists.service';
import { LearningService } from './learning.service';

class ItemDto {
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsBoolean() critical?: boolean;
  @IsOptional() @IsBoolean() evidenceRequired?: boolean;
}
class TemplateDto {
  @IsOptional() @IsString() code?: string;
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) attachmentIds?: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}
class AssignDto {
  @IsString() templateId!: string;
  @IsString() employeeId!: string;
  @IsString() branchId!: string;
  @IsIn(['DAILY', 'WEEKLY']) recurrence!: 'DAILY' | 'WEEKLY';
  @IsOptional() @IsInt() @Min(0) @Max(6) weekday?: number;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) dueTime!: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
class RequestDto {
  @IsString() templateId!: string;
  @IsString() employeeId!: string;
  @IsString() branchId!: string;
  @IsDateString() dueAt!: string;
  @IsOptional() @IsString() note?: string;
}
class AnswerDto {
  @IsString() itemId!: string;
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() docId?: string;
  @IsOptional() @IsString() value?: string;
}
class SubmitDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AnswerDto) answers!: AnswerDto[];
  @IsOptional() @IsDateString() completedAt?: string;
}

@ApiTags('operations')
@ApiBearerAuth()
@Controller('ops')
export class OperationsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Roles(...MANAGERS) @Get('checklist-templates') templates(@CurrentUser() u: RequestUser, @Query('all') all?: string) { return this.checklists.templates(u, all === '1'); }
  @Roles(...MANAGERS) @Post('checklist-templates') saveTemplate(@Body() dto: TemplateDto, @CurrentUser() u: RequestUser) { return this.checklists.saveTemplate(dto, u); }
  @Roles(...MANAGERS) @Get('checklist-assignments') assignments(@CurrentUser() u: RequestUser, @Query('branchId') b?: string) { return this.checklists.assignments(u, b); }
  @Roles(...MANAGERS) @Post('checklist-assignments') assign(@Body() dto: AssignDto, @CurrentUser() u: RequestUser) { return this.checklists.assign(dto, u); }
  @Roles(...MANAGERS) @Post('checklist-assignments/:id/stop') stop(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.checklists.stop(id, u); }
  @Roles(...MANAGERS) @Post('checklist-runs') request(@Body() dto: RequestDto, @CurrentUser() u: RequestUser) { return this.checklists.request(dto, u); }
  @Roles(...MANAGERS) @Get('checklist-runs') runs(@Query() q: { branchId?: string; employeeId?: string; status?: string; from?: string; to?: string }, @CurrentUser() u: RequestUser) { return this.checklists.runs(q, u); }
  @Roles(...MANAGERS) @Get('checklist-runs/:id') run(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.checklists.run(id, u); }
  @Roles(...MANAGERS) @Post('checklist-runs/:id/review') review(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.checklists.review(id, u); }
  @Roles(...MANAGERS) @Get('monitor') monitor(@Query() q: { branchId?: string; from?: string; to?: string }, @CurrentUser() u: RequestUser) { return this.checklists.monitor(q, u); }
  @Roles(...MANAGERS) @Post('checklists/sweep') sweep() { return this.checklists.sweep(); }
}

// E12 My Tasks, E13 Checklist Execution
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/checklists')
export class MyChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get() mine(@CurrentUser() u: RequestUser) { return this.checklists.mine(u); }
  @Get(':id') one(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.checklists.mineOne(id, u); }
  @Post(':id/submit') submit(@Param('id') id: string, @Body() dto: SubmitDto, @CurrentUser() u: RequestUser) { return this.checklists.submit(id, dto.answers, u, dto.completedAt); }
}

class ItemBodyDto {
  @IsOptional() @IsString() code?: string;
  @IsIn(['SOP', 'TRAINING']) kind!: string;
  @IsString() @MinLength(2) title!: string;
  @IsString() body!: string; // may be short when files carry the material
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) attachmentIds?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(100) passScore?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxAttempts?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) questionsPerAttempt?: number;
}
class QuestionDto {
  @IsString() @MinLength(5) text!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(6) @IsString({ each: true }) options!: string[];
  @IsInt() @Min(0) correctIndex!: number;
}
class GenerateDto { @IsInt() @Min(1) @Max(20) count!: number; }
class DecideDto { @IsBoolean() approve!: boolean; }
class TrainAssignDto {
  @IsString() employeeId!: string;
  @IsString() itemId!: string;
  @IsOptional() @IsDateString() dueDate?: string;
}
class RuleDto {
  @IsString() positionId!: string;
  @IsString() itemCode!: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) dueDays?: number;
}
class EvalDto {
  @IsString() employeeId!: string;
  @IsString() @MinLength(2) topic!: string;
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() notes?: string;
}
class ExamAnswersDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ExamAnswerDto) answers!: ExamAnswerDto[];
}
class ExamAnswerDto {
  @IsString() questionId!: string;
  @IsInt() @Min(0) index!: number;
}

@ApiTags('operations')
@ApiBearerAuth()
@Controller('ops')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Roles(...MANAGERS) @Get('library') library(@Query('all') all?: string) { return this.learning.library(all === '1'); }
  @Roles(...MANAGERS) @Post('library') saveItem(@Body() dto: ItemBodyDto, @CurrentUser() u: RequestUser) { return this.learning.saveItem(dto, u); }
  @Roles(...MANAGERS) @Get('library/:code/questions') questions(@Param('code') code: string, @CurrentUser() u: RequestUser, @Query('status') status?: string) { return this.learning.questions(code, u, status); }
  @Roles(...MANAGERS) @Post('library/:code/questions') addQuestion(@Param('code') code: string, @Body() dto: QuestionDto, @CurrentUser() u: RequestUser) { return this.learning.addQuestion(code, dto, u); }
  @Roles(...MANAGERS) @Post('library/:code/generate-questions') generate(@Param('code') code: string, @Body() dto: GenerateDto, @CurrentUser() u: RequestUser) { return this.learning.generate(code, dto.count, u); }
  @Roles(...MANAGERS) @Post('questions/:id/decide') decide(@Param('id') id: string, @Body() dto: DecideDto, @CurrentUser() u: RequestUser) { return this.learning.decideQuestion(id, dto.approve, u); }
  @Roles(...MANAGERS) @Get('training') overview(@Query() q: { employeeId?: string; status?: string }, @CurrentUser() u: RequestUser) { return this.learning.overview(q, u); }
  @Roles(...MANAGERS) @Post('training') assign(@Body() dto: TrainAssignDto, @CurrentUser() u: RequestUser) { return this.learning.assign(dto, u); }
  @Roles(...MANAGERS) @Post('training/:id/reset') reset(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.learning.reset(id, u); }
  @Roles(...MANAGERS) @Get('training-rules') rules() { return this.learning.rules(); }
  @Roles(...MANAGERS) @Post('training-rules') saveRule(@Body() dto: RuleDto, @CurrentUser() u: RequestUser) { return this.learning.saveRule(dto, u); }
  @Roles(...MANAGERS) @Post('training-rules/:id/stop') stopRule(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.learning.stopRule(id, u); }
  @Roles(...MANAGERS) @Post('training-rules/apply') apply() { return this.learning.applyRules(); }
  @Roles(...MANAGERS) @Post('evaluations') evaluate(@Body() dto: EvalDto, @CurrentUser() u: RequestUser) { return this.learning.evaluate(dto, u); }
  @Roles(...MANAGERS) @Get('evaluations') evaluations(@Query('employeeId') id: string, @CurrentUser() u: RequestUser) { return this.learning.evaluations(id, u); }
}

// E14 Training & SOPs, E15 Mandatory Examinations, E16 Training Results
@ApiTags('me')
@ApiBearerAuth()
@Controller('me/learning')
export class MyLearningController {
  constructor(private readonly learning: LearningService) {}

  @Get() mine(@CurrentUser() u: RequestUser) { return this.learning.mine(u); }
  @Get('results') results(@CurrentUser() u: RequestUser) { return this.learning.myResults(u); }
  @Post('attempts/:attemptId/submit') submit(@Param('attemptId') id: string, @Body() dto: ExamAnswersDto, @CurrentUser() u: RequestUser) { return this.learning.submit(id, dto.answers, u); }
  @Post(':id/open') open(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.learning.open(id, u); }
  @Post(':id/exam') exam(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.learning.startExam(id, u); }
}
