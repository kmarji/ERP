import { Body, Controller, Get, Global, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ProductKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import { CatalogService } from './catalog.service';

class ProductDto {
  @IsString() sku!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsEnum(ProductKind) kind?: ProductKind;
  @IsString() baseUnit!: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() taxCodeId?: string;
}

class ProductPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() taxCodeId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class ConversionDto {
  @IsString() unit!: string;
  @Type(() => Number) @IsNumber() @Min(0.000001) factorToBase!: number;
}

class SupplierDto {
  @IsString() name!: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsInt() @Min(0) paymentTermsDays?: number;
}

class SupplierItemDto {
  @IsString() productId!: string;
  @IsString() supplierSku!: string;
  @IsString() unit!: string;
  @IsOptional() @IsNumber() @Min(0) agreedPrice?: number;
  @IsOptional() @IsBoolean() preferred?: boolean;
}

class TaxCodeDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsNumber() @Min(0) rate!: number;
  @IsOptional() @IsBoolean() eligibleDefault?: boolean;
  @IsOptional() @IsString() notes?: string;
}

const WRITE = ['OWNER', 'FINANCE', 'PROCUREMENT'];

@ApiTags('catalog')
@ApiBearerAuth()
@Controller()
class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('products') products(@Query('kind') kind?: ProductKind, @Query('q') q?: string) {
    return this.prisma.db.product.findMany({
      where: { kind, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] } : {}) },
      include: { conversions: true, taxCode: true },
      orderBy: { sku: 'asc' },
      take: 500,
    });
  }

  @Roles(...WRITE) @Post('products') async addProduct(@Body() dto: ProductDto) {
    const row = await this.prisma.db.product.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'product.created', entityType: 'Product', entityId: row.id, after: row });
    return row;
  }

  @Roles(...WRITE) @Patch('products/:id') async patchProduct(@Param('id') id: string, @Body() dto: ProductPatchDto) {
    const before = await this.prisma.db.product.findFirst({ where: { id } });
    if (!before) throw new NotFoundException();
    await this.prisma.db.product.updateMany({ where: { id }, data: dto });
    await this.audit.record({ action: 'product.updated', entityType: 'Product', entityId: id, before, after: dto });
    return this.prisma.db.product.findFirstOrThrow({ where: { id } });
  }

  @Roles(...WRITE) @Post('products/:id/conversions') async addConversion(@Param('id') id: string, @Body() dto: ConversionDto) {
    return this.prisma.db.unitConversion.create({ data: { tenantId: '', productId: id, unit: dto.unit, factorToBase: dto.factorToBase } });
  }

  @Get('suppliers') suppliers() {
    return this.prisma.db.supplier.findMany({ orderBy: { name: 'asc' } });
  }

  @Roles(...WRITE) @Post('suppliers') async addSupplier(@Body() dto: SupplierDto) {
    const row = await this.prisma.db.supplier.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'supplier.created', entityType: 'Supplier', entityId: row.id, after: row });
    return row;
  }

  @Get('suppliers/:id/items') supplierItems(@Param('id') id: string) {
    return this.prisma.db.supplierItem.findMany({ where: { supplierId: id }, include: { product: true } });
  }

  @Roles(...WRITE) @Post('suppliers/:id/items') addSupplierItem(@Param('id') id: string, @Body() dto: SupplierItemDto) {
    return this.prisma.db.supplierItem.create({ data: { tenantId: '', supplierId: id, ...dto } });
  }

  @Get('tax-codes') taxCodes() {
    return this.prisma.db.taxCode.findMany({ orderBy: { code: 'asc' } });
  }

  @Roles('OWNER', 'FINANCE') @Post('tax-codes') addTaxCode(@Body() dto: TaxCodeDto) {
    return this.prisma.db.taxCode.create({ data: { tenantId: '', ...dto } });
  }
}

@Global()
@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
