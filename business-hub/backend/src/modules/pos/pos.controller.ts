import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { dateOnly } from '../../common/time';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { OfflineOp, OfflineService } from './offline.service';
import { OrdersService } from './orders.service';
import { PosReportsService } from './pos-reports.service';
import { RefundsService } from './refunds.service';
import { SalesPostingService } from './sales-posting.service';
import { SettlementsService } from './settlements.service';
import { POS_ROLES, ShiftsService } from './shifts.service';

class LineDto {
  @IsString() menuItemId!: string;
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) modifierIds?: string[];
  @IsInt() @Min(1) qty!: number;
  @IsOptional() @IsString() notes?: string;
}

class CreateOrderDto {
  @IsString() @MinLength(8) idempotencyKey!: string;
  @IsString() branchId!: string;
  @IsOptional() @IsIn(['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY']) channel?: 'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY';
  @IsOptional() @IsString() tableId?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsInt() @Min(1) guestCount?: number;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}

class PatchOrderDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsInt() @Min(1) guestCount?: number;
}

class QtyDto {
  @IsInt() @Min(1) qty!: number;
}

class AddLinesDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines!: LineDto[];
}

class OverrideDto {
  @IsString() email!: string;
  @IsString() password!: string;
}

class ReasonDto {
  @IsString() @MinLength(2) reason!: string;
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
}

class DiscountDto {
  @IsIn(['PERCENT', 'AMOUNT']) kind!: 'PERCENT' | 'AMOUNT';
  @IsNumber() @Min(0.001) value!: number;
  @IsString() @MinLength(2) reason!: string;
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
}

class CodeDto {
  @IsString() code!: string;
}

class PointsDto {
  @IsInt() @Min(1) points!: number;
}

class TableDto {
  @IsString() tableId!: string;
}

class SplitDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) lineIds!: string[];
}

class TenderDto {
  @IsString() @MinLength(8) idempotencyKey!: string;
  @IsIn(['CASH', 'CARD', 'DIGITAL', 'GIFT_CARD']) method!: 'CASH' | 'CARD' | 'DIGITAL' | 'GIFT_CARD';
  @IsOptional() @IsNumber() @Min(0.001) amount?: number;
  @IsOptional() @IsNumber() @Min(0.001) tendered?: number;
  @IsOptional() @IsString() reference?: string;
}

class RefundLineDto {
  @IsString() orderLineId!: string;
  @IsInt() @Min(1) qty!: number;
}

class RefundDto {
  @IsString() @MinLength(8) idempotencyKey!: string;
  @IsOptional() @IsBoolean() full?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RefundLineDto) lines?: RefundLineDto[];
  @IsString() @MinLength(2) reason!: string;
  @IsOptional() @IsBoolean() restock?: boolean;
  @IsOptional() @IsIn(['CASH', 'CARD', 'DIGITAL', 'GIFT_CARD', 'MARKETPLACE']) method?: 'CASH' | 'CARD' | 'DIGITAL' | 'GIFT_CARD' | 'MARKETPLACE';
  @IsOptional() @ValidateNested() @Type(() => OverrideDto) override?: OverrideDto;
}

class OpenShiftDto {
  @IsString() branchId!: string;
  @IsOptional() @IsNumber() @Min(0) openingFloat?: number;
  @IsOptional() @IsString() deviceId?: string;
}

class DropDto {
  @IsNumber() @Min(0.001) amount!: number;
  @IsOptional() @IsString() reason?: string;
}

class CloseShiftDto {
  @IsNumber() @Min(0) countedCash!: number;
}

class EnrollDto {
  @IsString() branchId!: string;
  @IsString() @MinLength(2) name!: string;
}

// Operations are validated one by one inside the service, so a single malformed sale never blocks the rest of a batch.
class SyncDto {
  @IsArray() @ArrayMinSize(1) operations!: unknown[];
}

class RetryDto {
  @IsOptional() @IsString() shiftId?: string;
}

class StatementLineDto {
  @IsString() reference!: string;
  @IsNumber() amount!: number;
}

class SettlementDto {
  @IsString() provider!: string;
  @IsDateString() settlementDate!: string;
  @IsString() reference!: string;
  @IsNumber() gross!: number;
  @IsNumber() fees!: number;
  @IsNumber() net!: number;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => StatementLineDto) lines!: StatementLineDto[];
}

class ResolveSettlementDto {
  @IsBoolean() accept!: boolean;
  @IsString() @MinLength(3) reason!: string;
}

const MANAGERS = ['OWNER', 'BRANCH_MANAGER'];
const REPORTERS = ['OWNER', 'FINANCE', 'BRANCH_MANAGER'];

@ApiTags('pos')
@ApiBearerAuth()
@Controller('pos')
export class PosController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly posting: SalesPostingService,
    private readonly offline: OfflineService,
    private readonly settlements: SettlementsService,
    private readonly reports: PosReportsService,
  ) {}

  // ------------------------------------------------ shifts
  @Roles(...POS_ROLES) @Post('shifts') openShift(@Body() dto: OpenShiftDto, @CurrentUser() u: RequestUser) {
    return this.shifts.open(dto, u);
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('shifts') listShifts(@Query('branchId') branchId?: string, @Query('status') status?: 'OPEN' | 'CLOSED') {
    return this.shifts.list({ branchId, status });
  }

  @Roles(...POS_ROLES) @Get('shifts/current') async current(@Query('branchId') branchId: string, @CurrentUser() u: RequestUser) {
    return (await this.shifts.currentFor(u, branchId)) ?? { shift: null };
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('shifts/:id') shift(@Param('id') id: string) {
    return this.shifts.get(id);
  }

  @Roles(...POS_ROLES) @Post('shifts/:id/drops') drop(@Param('id') id: string, @Body() dto: DropDto, @CurrentUser() u: RequestUser) {
    return this.shifts.drop(id, dto, u);
  }

  @Roles(...POS_ROLES) @Post('shifts/:id/close') close(@Param('id') id: string, @Body() dto: CloseShiftDto, @CurrentUser() u: RequestUser) {
    return this.shifts.close(id, dto, u);
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('shifts/:id/report') shiftReport(@Param('id') id: string) {
    return this.shifts.report(id);
  }

  // ------------------------------------------------ orders
  @Roles(...POS_ROLES) @Post('orders') create(@Body() dto: CreateOrderDto, @CurrentUser() u: RequestUser) {
    return this.orders.create(dto, u);
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('orders') list(@Query('branchId') branchId?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('take') take?: string) {
    return this.orders.list({ branchId, status, from: from ? dateOnly(from) : undefined, to: to ? new Date(`${to.slice(0, 10)}T23:59:59.999Z`) : undefined, take: take ? +take : undefined });
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('orders/:id') async order(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    await this.orders.forUser(id, u);
    return this.orders.detail(id);
  }

  @Roles(...POS_ROLES) @Patch('orders/:id') patchOrder(@Param('id') id: string, @Body() dto: PatchOrderDto, @CurrentUser() u: RequestUser) {
    return this.orders.patchOrder(id, dto, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/lines/:lineId/qty') setQty(@Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: QtyDto, @CurrentUser() u: RequestUser) {
    return this.orders.setLineQty(id, lineId, dto.qty, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/lines') addLines(@Param('id') id: string, @Body() dto: AddLinesDto, @CurrentUser() u: RequestUser) {
    return this.orders.addLines(id, dto.lines, u);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Roles(...POS_ROLES) @Post('orders/:id/lines/:lineId/void') voidLine(@Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) {
    return this.orders.voidLine(id, lineId, dto.reason, u, dto.override);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Roles(...POS_ROLES) @Post('orders/:id/discount') discount(@Param('id') id: string, @Body() dto: DiscountDto, @CurrentUser() u: RequestUser) {
    return this.orders.applyDiscount(id, dto, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/voucher') voucher(@Param('id') id: string, @Body() dto: CodeDto, @CurrentUser() u: RequestUser) {
    return this.orders.applyVoucher(id, dto.code, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/loyalty') loyalty(@Param('id') id: string, @Body() dto: PointsDto, @CurrentUser() u: RequestUser) {
    return this.orders.applyLoyalty(id, dto.points, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/send') send(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.orders.send(id, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/table') table(@Param('id') id: string, @Body() dto: TableDto, @CurrentUser() u: RequestUser) {
    return this.orders.transferTable(id, dto.tableId, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/split') split(@Param('id') id: string, @Body() dto: SplitDto, @CurrentUser() u: RequestUser) {
    return this.orders.split(id, dto.lineIds, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/tenders') tender(@Param('id') id: string, @Body() dto: TenderDto, @CurrentUser() u: RequestUser) {
    return this.orders.addTender(id, dto, u);
  }

  @Roles(...POS_ROLES) @Post('orders/:id/complete') complete(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.orders.complete(id, u);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Roles(...POS_ROLES) @Post('orders/:id/void') voidOrder(@Param('id') id: string, @Body() dto: ReasonDto, @CurrentUser() u: RequestUser) {
    return this.orders.voidOrder(id, dto.reason, u, dto.override);
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('orders/:id/receipt') async receipt(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    await this.orders.forUser(id, u);
    return this.orders.receipt(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('orders/:id/repost') repost(@Param('id') id: string) {
    return this.posting.repostSale(id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Roles(...POS_ROLES, 'FINANCE') @Post('orders/:id/refunds') refund(@Param('id') id: string, @Body() dto: RefundDto, @CurrentUser() u: RequestUser) {
    return this.refunds.refund(id, dto, u);
  }

  @Roles(...POS_ROLES, 'FINANCE') @Get('orders/:id/refunds') async refundList(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    await this.orders.forUser(id, u);
    return this.refunds.list(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('refunds/:id/repost') repostRefund(@Param('id') id: string) {
    return this.posting.postRefund(id);
  }

  // ------------------------------------------------ devices and offline sync
  @Roles(...MANAGERS) @Post('devices') enroll(@Body() dto: EnrollDto, @CurrentUser() u: RequestUser) {
    return this.offline.enroll(dto, u);
  }

  @Roles(...MANAGERS) @Get('devices') devices(@CurrentUser() u: RequestUser) {
    return this.offline.list(u);
  }

  @Roles(...MANAGERS) @Post('devices/:id/revoke') revoke(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.offline.revoke(id, u);
  }

  @Roles(...POS_ROLES) @Get('offline/bundle') bundle(@Headers('x-device-id') deviceId: string, @Headers('x-device-key') key: string, @CurrentUser() u: RequestUser) {
    return this.offline.bundle(deviceId, key, u);
  }

  // A longer-lived session for an enrolled device, so a tablet that was offline for hours can still sync on reconnect.
  @Roles(...POS_ROLES) @Post('session') session(@Headers('x-device-id') deviceId: string, @Headers('x-device-key') key: string, @CurrentUser() u: RequestUser) {
    return this.offline.issueSession(deviceId, key, u);
  }

  @Roles(...POS_ROLES) @Post('sync') sync(@Headers('x-device-id') deviceId: string, @Headers('x-device-key') key: string, @Body() dto: SyncDto, @CurrentUser() u: RequestUser) {
    return this.offline.sync(deviceId, key, dto.operations as OfflineOp[], u);
  }

  @Roles(...MANAGERS) @Get('sync/operations') operations(@Query('status') status?: 'APPLIED' | 'REJECTED') {
    return this.offline.listOperations(status);
  }

  @Roles(...MANAGERS) @Post('sync/operations/:id/retry') retry(@Param('id') id: string, @Body() dto: RetryDto, @CurrentUser() u: RequestUser) {
    return this.offline.retry(id, u, dto.shiftId);
  }

  // ------------------------------------------------ settlements and reports
  @Roles('OWNER', 'FINANCE') @Post('settlements') importSettlement(@Body() dto: SettlementDto, @CurrentUser() u: RequestUser) {
    return this.settlements.import(dto, u);
  }

  @Roles('OWNER', 'FINANCE') @Get('settlements') settlementList() {
    return this.settlements.list();
  }

  @Roles('OWNER', 'FINANCE') @Post('settlements/check-missing') checkMissing(@Query('olderThanDays') days?: string) {
    return this.settlements.findMissingPayouts(days ? +days : 3);
  }

  @Roles('OWNER', 'FINANCE') @Get('settlements/:id') settlement(@Param('id') id: string) {
    return this.settlements.get(id);
  }

  @Roles('OWNER', 'FINANCE') @Post('settlements/:id/resolve') resolveSettlement(@Param('id') id: string, @Body() dto: ResolveSettlementDto, @CurrentUser() u: RequestUser) {
    return this.settlements.resolve(id, dto, u);
  }

  @Roles(...REPORTERS) @Get('reports/sales') salesReport(@Query('from') from?: string, @Query('to') to?: string, @Query('branchId') branchId?: string) {
    return this.reports.sales({ from: from ? dateOnly(from) : undefined, to: to ? new Date(`${to.slice(0, 10)}T23:59:59.999Z`) : undefined, branchId });
  }
}
