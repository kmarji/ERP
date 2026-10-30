import { Body, CanActivate, Controller, Patch, ExecutionContext, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { IsBoolean, IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Public, Roles } from '../auth/auth.decorators';
import { TenancyService } from './tenancy.service';

class BootstrapDto {
  @IsString() name!: string;
  @Matches(/^[a-z0-9-]{2,40}$/) slug!: string;
  @IsEmail() ownerEmail!: string;
  @IsString() ownerName!: string;
  @IsString() @MinLength(10) ownerPassword!: string;
  @IsOptional() @IsString() legalEntityName?: string;
}

class LegalEntityDto {
  @IsString() name!: string;
  @IsOptional() @IsString() taxNumber?: string;
}

class LegalEntityPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() taxNumber?: string;
}

class BranchDto {
  @IsString() legalEntityId!: string;
  @IsString() code!: string;
  @IsString() name!: string;
}

class CostCenterDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() branchId?: string;
}

class StockLocationDto {
  @IsString() branchId!: string;
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsBoolean() isSalesLocation?: boolean;
}

// Checked as a guard so a wrong token is rejected (403) before the body is even validated.
@Injectable()
class BootstrapTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('BOOTSTRAP_TOKEN');
    const a = Buffer.from(String(ctx.switchToHttp().getRequest().headers['x-bootstrap-token'] ?? ''));
    const b = Buffer.from(expected ?? '');
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('Bootstrap not permitted');
    return true;
  }
}

@ApiTags('tenancy')
@Controller()
class TenancyController {
  constructor(
    private readonly svc: TenancyService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Platform-operator onboarding. Disabled unless BOOTSTRAP_TOKEN is configured.
  @Public()
  @UseGuards(BootstrapTokenGuard)
  @Post('tenants/bootstrap')
  bootstrap(@Body() dto: BootstrapDto) {
    return this.svc.bootstrap(dto);
  }

  @ApiBearerAuth() @Get('org/legal-entities') legalEntities() {
    return this.prisma.db.legalEntity.findMany();
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Post('org/legal-entities')
  async addLegalEntity(@Body() dto: LegalEntityDto) {
    const row = await this.prisma.db.legalEntity.create({ data: { tenantId: '', name: dto.name, taxNumber: dto.taxNumber ?? null } });
    await this.audit.record({ action: 'legal_entity.created', entityType: 'LegalEntity', entityId: row.id, after: row });
    return row;
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Patch('org/legal-entities/:id')
  async patchLegalEntity(@Param('id') id: string, @Body() dto: LegalEntityPatchDto) {
    const before = await this.prisma.db.legalEntity.findFirst({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.prisma.db.legalEntity.updateMany({ where: { id }, data: dto });
    await this.audit.record({ action: 'legal_entity.updated', entityType: 'LegalEntity', entityId: id, before, after: dto });
    return this.prisma.db.legalEntity.findFirstOrThrow({ where: { id } });
  }

  @ApiBearerAuth() @Get('org/branches') branches() {
    return this.prisma.db.branch.findMany({ orderBy: { code: 'asc' } });
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Post('org/branches')
  async addBranch(@Body() dto: BranchDto) {
    const row = await this.prisma.db.branch.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'branch.created', entityType: 'Branch', entityId: row.id, after: row });
    return row;
  }

  @ApiBearerAuth() @Get('org/cost-centers') costCenters() {
    return this.prisma.db.costCenter.findMany();
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Post('org/cost-centers')
  addCostCenter(@Body() dto: CostCenterDto) {
    return this.prisma.db.costCenter.create({ data: { tenantId: '', code: dto.code, name: dto.name, branchId: dto.branchId ?? null } });
  }

  @ApiBearerAuth() @Get('org/stock-locations') stockLocations() {
    return this.prisma.db.stockLocation.findMany();
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'PROCUREMENT') @Post('org/stock-locations')
  addStockLocation(@Body() dto: StockLocationDto) {
    return this.prisma.db.stockLocation.create({ data: { tenantId: '', ...dto } });
  }
}

@Module({ controllers: [TenancyController], providers: [TenancyService, BootstrapTokenGuard], exports: [TenancyService] })
export class TenancyModule {}
