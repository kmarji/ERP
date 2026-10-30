import { Body, Controller, Get, Module, Param, Post, Query, Req, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators';
import { OnboardingService } from './onboarding.service';

class AllowanceDto {
  @IsString() name!: string;
  @IsNumber() @Min(0) amount!: number;
}

class OfferDto {
  @IsDateString() startDate!: string;
  @IsNumber() @Min(0) salaryBasic!: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllowanceDto) allowances?: AllowanceDto[];
  @IsOptional() @IsIn(['OPEN', 'FIXED_TERM']) contractType?: 'OPEN' | 'FIXED_TERM';
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsInt() @Min(0) probationMonths?: number;
  @IsOptional() @IsNumber() @Min(1) weeklyHours?: number;
}

class AcceptDto {
  @IsString() @MinLength(2) @MaxLength(100) signatureName!: string;
  @IsBoolean() agree!: boolean;
}

class DeclineDto {
  @IsString() @MinLength(2) @MaxLength(300) reason!: string;
}

class PersonalDto {
  @IsString() @MinLength(5) @MaxLength(30) nationalId!: string;
  @IsDateString() dateOfBirth!: string;
  @IsString() @MinLength(5) @MaxLength(300) address!: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9 ]{10,40}$/) iban?: string;
}

class VerifyDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

const HR = ['HR', 'OWNER'];

@ApiTags('onboarding')
@Controller()
class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  // ---------------------------------------------------------------- staff
  @ApiBearerAuth() @Roles('HR', 'OWNER', 'FINANCE') @Post('applications/:id/offer') create(@Param('id') id: string, @Body() dto: OfferDto, @CurrentUser() u: RequestUser) {
    return this.svc.createOffer(id, dto, u);
  }

  @ApiBearerAuth() @Roles('HR', 'OWNER', 'FINANCE') @Get('applications/:id/offer') forApp(@Param('id') id: string) {
    return this.svc.offerForApplication(id);
  }

  @ApiBearerAuth() @Roles('HR', 'OWNER', 'FINANCE') @Get('offers') offers(@Query('status') status?: string) {
    return this.svc.listOffers(status);
  }

  @ApiBearerAuth() @Roles(...HR) @Post('offers/:id/send') send(@Param('id') id: string) {
    return this.svc.sendOffer(id);
  }

  @ApiBearerAuth() @Roles(...HR) @Post('offers/:id/withdraw') withdraw(@Param('id') id: string) {
    return this.svc.withdrawOffer(id);
  }

  @ApiBearerAuth() @Roles(...HR) @Post('offers/:id/countersign') countersign(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.svc.countersign(id, u);
  }

  @ApiBearerAuth() @Roles(...HR) @Get('applications/:id/documents') documents(@Param('id') id: string) {
    return this.svc.listDocuments(id);
  }

  @ApiBearerAuth() @Roles(...HR) @Post('applications/:id/documents/:type/verify') verify(@Param('id') id: string, @Param('type') type: string, @Body() dto: VerifyDto, @CurrentUser() u: RequestUser) {
    return this.svc.verifyDocument(id, type, dto, u);
  }

  @ApiBearerAuth() @Roles(...HR) @Post('applications/:id/complete-onboarding') complete(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.svc.completeOnboarding(id, u);
  }

  // ---------------------------------------------------------------- candidate (authorized by the unguessable tracking token)
  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('apply/status/:token/offer') candidateOffer(@Param('token') token: string) {
    return this.svc.candidateOffer(token);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('apply/status/:token/offer/accept') accept(@Param('token') token: string, @Body() dto: AcceptDto, @Req() req: any) {
    return this.svc.acceptOffer(token, dto, `${req.ip}|${req.headers['user-agent'] ?? ''}`);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('apply/status/:token/offer/decline') decline(@Param('token') token: string, @Body() dto: DeclineDto) {
    return this.svc.declineOffer(token, dto.reason);
  }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @Post('apply/status/:token/documents/:type') upload(@Param('token') token: string, @Param('type') type: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    return this.svc.uploadDocument(token, type, file);
  }

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('apply/status/:token/personal-details') personal(@Param('token') token: string, @Body() dto: PersonalDto) {
    return this.svc.savePersonalDetails(token, dto);
  }
}

@Module({ controllers: [OnboardingController], providers: [OnboardingService], exports: [OnboardingService] })
export class OnboardingModule {}
