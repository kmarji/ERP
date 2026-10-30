import { Body, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators';
import { StubAggregatorAdapter, AggregatorAdapter, ExternalOrder, ExternalSettlement } from './commerce.adapters';
import { AggregatorService } from './aggregator.service';
import { FULFILMENT_ROLES, FulfilmentService } from './fulfilment.service';
import { PlaceOrderInput, StoreService } from './store.service';

// ------------------------------------------------------------------ public storefront DTOs

class StoreLineDto {
  @IsString() menuItemId!: string;
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) modifierIds?: string[];
  @IsInt() @Min(1) @Max(50) qty!: number;
  @IsOptional() @IsString() @MaxLength(200) notes?: string;
}

class CustomerDto {
  @IsString() @MinLength(2) @MaxLength(100) name!: string;
  @IsString() @MinLength(7) @MaxLength(20) phone!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBoolean() consent?: boolean;
}

class AddressDto {
  @IsString() @MaxLength(100) area!: string;
  @IsString() @MaxLength(300) text!: string;
}

class PaymentDto {
  @IsIn(['CASH_ON_DELIVERY', 'CARD_ONLINE']) method!: 'CASH_ON_DELIVERY' | 'CARD_ONLINE';
  // A gateway-issued token only. Card numbers are rejected by validation (unknown fields are refused).
  @IsOptional() @IsString() @MaxLength(200) token?: string;
}

class PlaceOrderDto {
  @IsString() @MinLength(8) @MaxLength(100) idempotencyKey!: string;
  @IsString() branchId!: string;
  @IsIn(['PICKUP', 'DELIVERY']) fulfilment!: 'PICKUP' | 'DELIVERY';
  @ValidateNested() @Type(() => CustomerDto) customer!: CustomerDto;
  @IsOptional() @ValidateNested() @Type(() => AddressDto) address?: AddressDto;
  @IsOptional() @IsDateString() scheduledFor?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => StoreLineDto) lines!: StoreLineDto[];
  @ValidateNested() @Type(() => PaymentDto) payment!: PaymentDto;
}

// ------------------------------------------------------------------ staff DTOs

class StoreConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() acceptingOrders?: boolean;
  @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @IsOptional() @IsBoolean() deliveryEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) deliveryFee?: number;
  @IsOptional() @IsNumber() @Min(0) minOrder?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) serviceAreas?: string[];
  @IsOptional() @IsInt() @Min(1) prepMinutes?: number;
  @IsOptional() @IsBoolean() autoAccept?: boolean;
  @IsOptional() @IsBoolean() scheduledOrdering?: boolean;
}

class ReasonDto {
  @IsString() @MinLength(3) reason!: string;
}

class DispatchDto {
  @IsOptional() @IsString() driver?: string;
}

class CashDto {
  @IsNumber() @Min(0) tendered!: number;
}

class DeliverDto {
  @IsOptional() @ValidateNested() @Type(() => CashDto) cash?: CashDto;
}

class ConnectionDto {
  @IsIn(['TALABAT', 'CAREEM']) provider!: 'TALABAT' | 'CAREEM';
  @IsString() branchId!: string;
  @IsString() storeRef!: string;
  @IsOptional() @IsBoolean() autoAccept?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(1) commissionRate?: number;
}

class ConnectionPatchDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoAccept?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(1) commissionRate?: number;
}

class MappingDto {
  @IsString() externalItemId!: string;
  @IsString() menuItemId!: string;
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsObject() modifierMap?: Record<string, string>;
}

class MappingsDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => MappingDto) mappings!: MappingDto[];
}

const MANAGERS = ['OWNER', 'BRANCH_MANAGER'];

@ApiTags('commerce')
@Controller()
export class CommerceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: StoreService,
    private readonly fulfil: FulfilmentService,
    private readonly aggregators: AggregatorService,
    private readonly adapter: AggregatorAdapter,
  ) {}

  // ================================================================ public storefront (no login)

  @Public() @Get('store/:tenant/branches') branches(@Param('tenant') tenant: string) {
    return this.store.branches(tenant);
  }

  @Public() @Get('store/:tenant/branches/:branchId/menu') menu(@Param('tenant') tenant: string, @Param('branchId') branchId: string) {
    return this.store.publicMenu(tenant, branchId);
  }

  @Public() @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post('store/:tenant/orders') place(@Param('tenant') tenant: string, @Body() dto: PlaceOrderDto) {
    return this.store.placeOrder(tenant, dto as PlaceOrderInput);
  }

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Get('store/:tenant/track/:code') track(@Param('tenant') tenant: string, @Param('code') code: string) {
    return this.store.track(tenant, code);
  }

  // ================================================================ staff: online store setup and fulfilment

  @ApiBearerAuth() @Roles(...MANAGERS) @Get('online-store/:branchId') getConfig(@Param('branchId') branchId: string, @CurrentUser() u: RequestUser) {
    return this.store.getConfig(branchId, u);
  }

  @ApiBearerAuth() @Roles(...MANAGERS) @Put('online-store/:branchId') putConfig(@Param('branchId') branchId: string, @Body() dto: StoreConfigDto, @CurrentUser() u: RequestUser) {
    return this.store.putConfig(branchId, dto as Record<string, unknown>, u);
  }

  @ApiBearerAuth() @Roles(...FULFILMENT_ROLES, 'FINANCE') @Get('online-orders') list(@Query('branchId') branchId?: string, @Query('status') status?: string, @Query('source') source?: string) {
    return this.fulfil.list({ branchId, status, source });
  }

  @ApiBearerAuth() @Roles(...FULFILMENT_ROLES) @Post('online-orders/:id/accept') accept(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.fulfil.accept(id, u);
  }

  @ApiBearerAuth() @Roles(...FULFILMENT_ROLES) @Post('online-orders/:id/reject') reject(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) {
    return this.fulfil.reject(id, dto.reason, u);
  }

  @ApiBearerAuth() @Roles(...FULFILMENT_ROLES) @Post('online-orders/:id/ready') ready(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.fulfil.ready(id, u);
  }

  @ApiBearerAuth() @Roles(...FULFILMENT_ROLES) @Post('online-orders/:id/dispatch') dispatch(@Param('id') id: string, @Body() dto: DispatchDto, @CurrentUser() u: RequestUser) {
    return this.fulfil.dispatch(id, dto, u);
  }

  @ApiBearerAuth() @Roles('OWNER', 'BRANCH_MANAGER', 'CASHIER') @Post('online-orders/:id/deliver') deliver(@Param('id') id: string, @Body() dto: DeliverDto, @CurrentUser() u: RequestUser) {
    return this.fulfil.deliver(id, dto, u);
  }

  @ApiBearerAuth() @Roles(...MANAGERS) @Post('online-orders/:id/cancel') cancel(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) {
    return this.fulfil.cancel(id, dto.reason, u);
  }

  // ================================================================ staff: marketplaces

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Get('aggregators/connections') connections() {
    return this.aggregators.listConnections();
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Post('aggregators/connections') connect(@Body() dto: ConnectionDto) {
    return this.aggregators.createConnection(dto);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Patch('aggregators/connections/:id') patchConnection(@Param('id') id: string, @Body() dto: ConnectionPatchDto) {
    return this.aggregators.patchConnection(id, dto);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Get('aggregators/connections/:id/mappings') mappings(@Param('id') id: string) {
    return this.aggregators.listMappings(id);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Put('aggregators/connections/:id/mappings') putMappings(@Param('id') id: string, @Body() dto: MappingsDto) {
    return this.aggregators.putMappings(id, dto.mappings);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Get('aggregators/inbound') inbound(@Query('status') status?: string) {
    return this.aggregators.listInbound(status);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Post('aggregators/inbound/:id/reprocess') reprocess(@Param('id') id: string) {
    return this.aggregators.reprocess(id);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Post('aggregators/connections/:id/poll') poll(@Param('id') id: string) {
    return this.aggregators.poll(id);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Post('aggregators/connections/:id/settlements/sync') syncSettlements(@Param('id') id: string) {
    return this.aggregators.syncSettlements(id);
  }

  @ApiBearerAuth() @Roles('OWNER', 'FINANCE') @Get('aggregators/report') report() {
    return this.aggregators.report();
  }

  // Marketplace webhook: authenticated by the connection's shared secret, not by a user login.
  @Public() @Throttle({ default: { limit: 120, ttl: 60_000 } }) @Post('aggregators/webhook/:tenant/:connectionId')
  async webhook(@Param('tenant') tenant: string, @Param('connectionId') connectionId: string, @Headers('x-webhook-secret') secret: string | undefined, @Body() body: ExternalOrder) {
    const t = await this.prisma.raw.tenant.findUnique({ where: { slug: tenant } });
    if (!t || !t.active) throw new NotFoundException();
    return this.aggregators.webhook(connectionId, secret, body, t.id);
  }

  // ================================================================ development simulator (stub mode only)

  private stub() {
    if (!(this.adapter instanceof StubAggregatorAdapter)) throw new ForbiddenException('The marketplace simulator is only available with stub adapters');
    return this.adapter;
  }

  @ApiBearerAuth() @Roles('OWNER') @Post('aggregators/stub/orders') async stubOrder(@Body() body: { provider: string; storeRef: string; order: ExternalOrder }) {
    this.stub().inject(body.provider, body.storeRef, body.order);
    return { queued: true };
  }

  @ApiBearerAuth() @Roles('OWNER') @Post('aggregators/stub/statements') async stubStatement(@Body() body: { provider: string; storeRef: string; statement: ExternalSettlement }) {
    this.stub().injectStatement(body.provider, body.storeRef, body.statement);
    return { queued: true };
  }

  @ApiBearerAuth() @Roles('OWNER') @Post('aggregators/stub/outage') async stubOutage(@Body() body: { provider: string; down: boolean }) {
    this.stub().setOutage(body.provider, body.down);
    return { provider: body.provider, down: body.down };
  }

  @ApiBearerAuth() @Roles('OWNER') @Get('aggregators/stub/outbox') async outbox() {
    return this.stub().outbox;
  }
}
