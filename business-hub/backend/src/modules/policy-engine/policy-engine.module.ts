import { Body, Controller, Delete, Get, Global, Module, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RiskTier } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PolicyService } from './policy.service';

class CreatePolicyDto {
  @IsString() key!: string;
  @IsEnum(RiskTier) riskTier!: RiskTier;
  @IsObject() rules!: Record<string, unknown>;
}

class LimitDto {
  @IsString() policyKey!: string;
  @IsString() roleKey!: string;
  @Type(() => Number) @IsNumber() @Min(0) maxAmount!: number;
  @IsOptional() @IsString() legalEntityId?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() category?: string;
}

class EvaluateDto {
  @IsString() policyKey!: string;
  @IsOptional() @IsNumber() amount?: number;
  @IsOptional() @IsNumber() variancePct?: number;
  @IsOptional() @IsNumber() confidence?: number;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() category?: string;
}

@ApiTags('policies')
@ApiBearerAuth()
@Controller('policies')
class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Get() list() {
    return this.policies.list();
  }

  @Roles('OWNER', 'FINANCE')
  @Post()
  create(@Body() dto: CreatePolicyDto, @CurrentUser() u: RequestUser) {
    return this.policies.createVersion(dto.key, dto.riskTier, dto.rules as any, u.id);
  }

  @Roles('OWNER', 'FINANCE')
  @Post(':key/activate/:version')
  activate(@Param('key') key: string, @Param('version', ParseIntPipe) version: number) {
    return this.policies.activate(key, version);
  }

  @Roles('OWNER', 'FINANCE')
  @Post(':key/deactivate')
  deactivate(@Param('key') key: string) {
    return this.policies.activate(key, null);
  }

  @Get('limits') limits() {
    return this.policies.listLimits();
  }

  @Roles('OWNER', 'FINANCE')
  @Post('limits')
  addLimit(@Body() dto: LimitDto) {
    return this.policies.upsertLimit(dto);
  }

  @Roles('OWNER', 'FINANCE')
  @Delete('limits/:id')
  removeLimit(@Param('id') id: string) {
    return this.policies.deleteLimit(id);
  }

  // Dry-run a decision: policies are testable before they go live.
  @Post('evaluate')
  evaluate(@Body() dto: EvaluateDto) {
    const { policyKey, ...input } = dto;
    return this.policies.evaluate(policyKey, input);
  }
}

@Global()
@Module({ controllers: [PolicyController], providers: [PolicyService], exports: [PolicyService] })
export class PolicyEngineModule {}
