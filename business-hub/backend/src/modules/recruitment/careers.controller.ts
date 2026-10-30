import { Body, Controller, Get, Ip, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { Public } from '../auth/auth.decorators';
import { ApplicationsService } from './applications.service';
import { InterviewsService } from './interviews.service';
import { VacanciesService } from './vacancies.service';

// Only objective, job-related fields exist here. Unknown fields (gender, age, nationality, ...) are refused by validation.
class AvailabilityDto {
  @IsOptional() @IsBoolean() weekends?: boolean;
  @IsOptional() @IsBoolean() nights?: boolean;
}

class IntakeDto {
  @IsOptional() @IsNumber() @Min(0) @Max(60) yearsExperience?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(60, { each: true }) skills?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true }) languages?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(80, { each: true }) certifications?: string[];
  @IsOptional() @ValidateNested() @Type(() => AvailabilityDto) availability?: AvailabilityDto;
  @IsOptional() @IsBoolean() workAuthorization?: boolean;
  @IsOptional() @IsNumber() @Min(0) expectedSalary?: number;
  @IsOptional() @IsString() @MaxLength(1000) motivation?: string;
}

class ApplyDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(7) @MaxLength(20) phone!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsBoolean() consent!: boolean;
  @ValidateNested() @Type(() => IntakeDto) intake!: IntakeDto;
}

class AppealDto {
  @IsString() @MinLength(10) @MaxLength(2000) reason!: string;
}

class ConsentDto {
  @IsBoolean() processing!: boolean;
  @IsOptional() @IsBoolean() recording?: boolean;
  @IsString() noticeVersion!: string;
}

class ScheduleDto {
  @IsString() scheduledFor!: string;
}

class AnswerDto {
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}

@ApiTags('careers')
@Controller()
export class CareersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vacancies: VacanciesService,
    private readonly applications: ApplicationsService,
    private readonly interviews: InterviewsService,
  ) {}

  private async inTenantSlug<T>(slug: string, fn: () => Promise<T>) {
    const t = await this.prisma.raw.tenant.findUnique({ where: { slug } });
    if (!t || !t.active) throw new NotFoundException('Not found');
    return runWithTenant(t.id, fn);
  }

  // Tokens are unguessable and globally unique, so the tenant is found from the token itself.
  private async inTokenTenant<T>(kind: 'application' | 'interview', token: string, fn: () => Promise<T>) {
    const row = kind === 'application' ? await this.prisma.raw.application.findUnique({ where: { trackingToken: token }, select: { tenantId: true } }) : await this.prisma.raw.interview.findUnique({ where: { accessToken: token }, select: { tenantId: true } });
    if (!row) throw new NotFoundException('Not found');
    return runWithTenant(row.tenantId, fn);
  }

  @Public() @Get('careers/:tenant/vacancies') list(@Param('tenant') tenant: string) {
    return this.inTenantSlug(tenant, () => this.vacancies.publicList());
  }

  @Public() @Get('careers/:tenant/vacancies/:code') vacancy(@Param('tenant') tenant: string, @Param('code') code: string) {
    return this.inTenantSlug(tenant, () => this.vacancies.publicGet(code));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('careers/:tenant/vacancies/:code/apply') apply(@Param('tenant') tenant: string, @Param('code') code: string, @Body() dto: ApplyDto) {
    return this.inTenantSlug(tenant, () => this.applications.apply(code, dto));
  }

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('apply/status/:token') status(@Param('token') token: string) {
    return this.inTokenTenant('application', token, () => this.applications.statusView(token));
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Put('apply/status/:token/intake') intake(@Param('token') token: string, @Body() dto: IntakeDto) {
    return this.inTokenTenant('application', token, () => this.applications.updateIntake(token, dto));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('apply/status/:token/withdraw') withdraw(@Param('token') token: string) {
    return this.inTokenTenant('application', token, () => this.applications.withdraw(token));
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('apply/status/:token/appeal') appeal(@Param('token') token: string, @Body() dto: AppealDto) {
    return this.inTokenTenant('application', token, () => this.applications.openAppeal(token, dto.reason));
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('apply/status/:token/erase') erase(@Param('token') token: string) {
    return this.inTokenTenant('application', token, () => this.applications.erase(token));
  }

  // ------------------------------------------------------------ interview (candidate side)

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('apply/interview/:token') notice(@Param('token') token: string) {
    return this.inTokenTenant('interview', token, () => this.interviews.notice(token));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('apply/interview/:token/consent') consent(@Param('token') token: string, @Body() dto: ConsentDto, @Ip() ip: string) {
    return this.inTokenTenant('interview', token, () => this.interviews.consent(token, dto, ip));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('apply/interview/:token/schedule') schedule(@Param('token') token: string, @Body() dto: ScheduleDto) {
    return this.inTokenTenant('interview', token, () => this.interviews.schedule(token, dto.scheduledFor));
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('apply/interview/:token/start') start(@Param('token') token: string) {
    return this.inTokenTenant('interview', token, () => this.interviews.start(token));
  }

  @Public() @Throttle({ default: { limit: 40, ttl: 60_000 } }) @Post('apply/interview/:token/answer') answer(@Param('token') token: string, @Body() dto: AnswerDto) {
    return this.inTokenTenant('interview', token, () => this.interviews.answer(token, dto.text));
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('apply/interview/:token/recording') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  recording(@Param('token') token: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    return this.inTokenTenant('interview', token, () => this.interviews.uploadRecording(token, file));
  }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('apply/interview/:token/request-human') human(@Param('token') token: string) {
    return this.inTokenTenant('interview', token, () => this.interviews.requestHuman(token));
  }
}

