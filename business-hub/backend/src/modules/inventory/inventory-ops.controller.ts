import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { dateOnly } from '../../common/time';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { INVENTORY_ROLES, InventoryOpsService, WASTAGE_ROLES } from './inventory-ops.service';

class CreateCountDto {
  @IsString() locationId!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) productIds?: string[];
}

class CountEntryDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0) qty!: number;
  @IsOptional() @IsString() unit?: string;
}

class SaveCountDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => CountEntryDto) entries!: CountEntryDto[];
}

class WastageDto {
  @IsString() locationId!: string;
  @IsString() productId!: string;
  @IsNumber() @Min(0.0001) qty!: number;
  @IsOptional() @IsString() unit?: string;
  @IsIn(['EXPIRED', 'SPOILED', 'DAMAGED', 'PREP_WASTE', 'OTHER']) reason!: string;
  @IsOptional() @IsString() notes?: string;
}

class TransferLineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.0001) qty!: number;
  @IsOptional() @IsString() unit?: string;
}

class TransferDto {
  @IsString() fromLocationId!: string;
  @IsString() toLocationId!: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TransferLineDto) lines!: TransferLineDto[];
}

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryOpsController {
  constructor(private readonly ops: InventoryOpsService) {}

  @Roles(...INVENTORY_ROLES) @Get('counts') counts(@Query('status') status?: string) {
    return this.ops.listCounts(status);
  }

  @Roles(...INVENTORY_ROLES) @Post('counts') createCount(@Body() dto: CreateCountDto, @CurrentUser() u: RequestUser) {
    return this.ops.createCount(dto, u);
  }

  @Roles(...INVENTORY_ROLES) @Get('counts/:id') count(@Param('id') id: string) {
    return this.ops.getCount(id);
  }

  @Roles(...INVENTORY_ROLES) @Put('counts/:id/lines') save(@Param('id') id: string, @Body() dto: SaveCountDto, @CurrentUser() u: RequestUser) {
    return this.ops.saveCounts(id, dto.entries, u);
  }

  @Roles(...INVENTORY_ROLES) @Post('counts/:id/submit') submit(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.ops.submitCount(id, u);
  }

  @Roles(...WASTAGE_ROLES) @Get('wastage') wastage(@Query('locationId') locationId?: string) {
    return this.ops.listWastage({ locationId });
  }

  @Roles(...WASTAGE_ROLES) @Post('wastage') record(@Body() dto: WastageDto, @CurrentUser() u: RequestUser) {
    return this.ops.recordWastage(dto, u);
  }

  @Roles(...INVENTORY_ROLES) @Get('transfers') transfers() {
    return this.ops.listTransfers();
  }

  @Roles(...INVENTORY_ROLES) @Post('transfers') transfer(@Body() dto: TransferDto, @CurrentUser() u: RequestUser) {
    return this.ops.transfer(dto, u);
  }

  @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Get('reports/losses') losses(@Query('from') from?: string, @Query('to') to?: string) {
    return this.ops.losses(from ? dateOnly(from) : undefined, to ? new Date(`${to.slice(0, 10)}T23:59:59.999Z`) : undefined);
  }

  @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Get('reports/actual-vs-theoretical') actualVsTheoretical(@Query('from') from?: string, @Query('to') to?: string, @Query('locationId') locationId?: string) {
    return this.ops.actualVsTheoretical(from ? dateOnly(from) : undefined, to ? new Date(`${to.slice(0, 10)}T23:59:59.999Z`) : undefined, locationId);
  }
}
