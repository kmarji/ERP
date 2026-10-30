import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { PurchasingService } from './purchasing.service';

class RequestLineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.0001) qty!: number;
  @IsString() unit!: string;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsNumber() @Min(0) estUnitPrice?: number;
}

class CreateRequestDto {
  @IsString() branchId!: string;
  @IsString() stockLocationId!: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RequestLineDto) lines!: RequestLineDto[];
}

class OrderLineDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0.0001) qty!: number;
  @IsString() unit!: string;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
}

class CreateOrderDto {
  @IsString() supplierId!: string;
  @IsString() branchId!: string;
  @IsString() stockLocationId!: string;
  @IsOptional() @IsDateString() expectedDate?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderLineDto) lines!: OrderLineDto[];
}

const BUYERS = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'];

@ApiTags('purchasing')
@ApiBearerAuth()
@Roles(...BUYERS)
@Controller()
class PurchasingController {
  constructor(private readonly svc: PurchasingService) {}

  @Get('purchase-requests') requests(@Query('status') status?: string) {
    return this.svc.listRequests(status);
  }

  @Post('purchase-requests') createRequest(@Body() dto: CreateRequestDto, @CurrentUser() u: RequestUser) {
    return this.svc.createRequest(dto, u);
  }

  @Get('purchase-requests/:id') request(@Param('id') id: string) {
    return this.svc.getRequest(id);
  }

  @Post('purchase-requests/:id/submit') submit(@Param('id') id: string) {
    return this.svc.submitRequest(id);
  }

  @Post('purchase-requests/:id/convert') convert(@Param('id') id: string) {
    return this.svc.convertRequest(id);
  }

  @Get('purchase-orders') orders(@Query('status') status?: string) {
    return this.svc.listOrders(status);
  }

  @Post('purchase-orders') createOrder(@Body() dto: CreateOrderDto, @CurrentUser() u: RequestUser) {
    return this.svc.createOrder(dto, { user: u });
  }

  @Get('purchase-orders/:id') order(@Param('id') id: string) {
    return this.svc.getOrder(id);
  }

  @Post('purchase-orders/:id/cancel') cancel(@Param('id') id: string) {
    return this.svc.cancelOrder(id);
  }
}

@Module({ controllers: [PurchasingController], providers: [PurchasingService], exports: [PurchasingService] })
export class PurchasingModule {}
