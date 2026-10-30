import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { PayableStatus } from '@prisma/client';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PayablesService } from './payables.service';
import { ReceivingService } from './receiving.service';

class InvoiceLineDto {
  @IsOptional() @IsString() supplierSku?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() productId?: string;
  @IsNumber() @Min(0) qty!: number;
  @IsString() unit!: string;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsNumber() lineNet?: number;
  @IsOptional() @IsNumber() lineTax?: number;
}

class InvoiceDto {
  @IsOptional() @IsString() invoiceNumber?: string;
  @IsOptional() @IsDateString() invoiceDate?: string;
  @IsOptional() @IsString() supplierTaxNumber?: string;
  @IsOptional() @IsString() qrUuid?: string;
  @IsOptional() @IsString() qrPayload?: string;
  @IsOptional() @IsNumber() subtotal?: number;
  @IsOptional() @IsNumber() taxTotal?: number;
  @IsOptional() @IsNumber() total?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines?: InvoiceLineDto[];
}

class ReceivedLineDto {
  @IsOptional() @IsString() poLineId?: string;
  @IsOptional() @IsString() productId?: string;
  @IsNumber() @Min(0.0001) qty!: number;
  @IsOptional() @IsString() unit?: string;
}

class ReceiveDto {
  @IsString() @MinLength(8) idempotencyKey!: string;
  @IsOptional() @IsString() purchaseOrderId?: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsString() branchId!: string;
  @IsString() stockLocationId!: string;
  @IsOptional() @IsString() evidenceDocumentId?: string;
  @IsOptional() @ValidateNested() @Type(() => InvoiceDto) invoice?: InvoiceDto;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceivedLineDto) receivedLines!: ReceivedLineDto[];
}

class ReasonDto {
  @IsString() @MinLength(3) reason!: string;
}

class PaymentDto {
  @IsString() @MinLength(2) reference!: string;
  @IsIn(['BANK', 'CASH']) method!: 'BANK' | 'CASH';
  @IsOptional() @IsDateString() paidAt?: string;
}

const RECEIVERS = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'];

@ApiTags('receiving')
@ApiBearerAuth()
@Controller()
class ReceivingController {
  constructor(
    private readonly receiving: ReceivingService,
    private readonly payables: PayablesService,
  ) {}

  @Roles(...RECEIVERS) @Post('receiving') receive(@Body() dto: ReceiveDto, @CurrentUser() u: RequestUser) {
    return this.receiving.receive(dto, u);
  }

  @Roles(...RECEIVERS) @Get('receiving') list(@Query('status') status?: string) {
    return this.receiving.list(status);
  }

  @Roles(...RECEIVERS) @Get('receiving/:id') one(@Param('id') id: string) {
    return this.receiving.outcome(id);
  }

  @Roles(...RECEIVERS) @Get('receiving/:id/trace') trace(@Param('id') id: string) {
    return this.receiving.trace(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('receiving/:id/override-post') override(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) {
    return this.receiving.overridePost(id, dto.reason, u);
  }

  @Roles(...RECEIVERS) @Post('receiving/:id/reject') reject(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.receiving.reject(id, dto.reason);
  }

  @Roles('OWNER', 'FINANCE') @Get('payables') payablesList(@Query('status') status?: PayableStatus) {
    return this.payables.list(status);
  }

  @Roles('OWNER', 'FINANCE') @Get('payables/:id') payable(@Param('id') id: string) {
    return this.payables.get(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('payables/:id/request-payment') requestPayment(@Param('id') id: string) {
    return this.payables.requestPayment(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('payables/:id/confirm-payment') confirm(@Param('id') id: string, @Body() dto: PaymentDto, @CurrentUser() u: RequestUser) {
    return this.payables.confirmPayment(id, dto, u);
  }
}

@Module({ controllers: [ReceivingController], providers: [ReceivingService, PayablesService], exports: [ReceivingService] })
export class ReceivingModule {}
