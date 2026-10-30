import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Global, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { randomInt, randomUUID } from 'node:crypto';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { FinancePostingService } from '../finance/finance-posting.service';
import { ammanToday } from '../../common/time';
import { GiftCardService, LoyaltyService, VoucherService } from './customers.contracts';

const CUSTOMER_ROLES = ['OWNER', 'FINANCE', 'BRANCH_MANAGER', 'CASHIER'];
const VOUCHER_ROLES = ['OWNER', 'FINANCE', 'BRANCH_MANAGER'];
const ISSUERS = ['CASHIER', 'BRANCH_MANAGER', 'OWNER', 'FINANCE'];
// Unambiguous alphabet: no 0/O/1/I.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class CustomerDto {
  @IsString() name!: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsBoolean() consent!: boolean;
  @IsOptional() @IsBoolean() marketingConsent?: boolean;
}

class VoucherDto {
  @IsString() code!: string;
  @IsIn(['PERCENT', 'AMOUNT']) kind!: 'PERCENT' | 'AMOUNT';
  @Type(() => Number) @IsNumber() @Min(0.001) value!: number;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string;
  @IsOptional() @IsInt() @Min(1) maxUses?: number;
}

class VoucherPatchDto {
  @IsBoolean() active!: boolean;
}

class IssueGiftCardDto {
  @Type(() => Number) @IsNumber() @Min(0.001) amount!: number;
  @IsIn(['CASH', 'CARD']) method!: 'CASH' | 'CARD';
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller()
class CustomersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: FinancePostingService,
  ) {}

  // ---- customers (explicit consent required; erasure anonymises but keeps loyalty history)
  @Roles(...CUSTOMER_ROLES) @Post('customers') async addCustomer(@Body() dto: CustomerDto) {
    if (dto.consent !== true) throw new BadRequestException('Explicit customer consent is required to store a profile');
    try {
      const row = await this.prisma.db.customer.create({
        data: { tenantId: '', name: dto.name, phone: dto.phone ?? null, email: dto.email ?? null, marketingConsent: dto.marketingConsent ?? false, consentAt: new Date() },
      });
      await this.audit.record({ action: 'customer.created', entityType: 'Customer', entityId: row.id });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A customer with this phone already exists');
      throw e;
    }
  }

  @Roles(...CUSTOMER_ROLES) @Get('customers') list(@Query('q') q?: string) {
    return this.prisma.db.customer.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } : {},
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  @Roles(...CUSTOMER_ROLES) @Get('customers/:id') async one(@Param('id') id: string) {
    const c = await this.prisma.db.customer.findFirst({ where: { id } });
    if (!c) throw new NotFoundException('Customer not found');
    return c;
  }

  @Roles(...CUSTOMER_ROLES) @Get('customers/:id/loyalty') loyalty(@Param('id') id: string) {
    return this.prisma.db.loyaltyTransaction.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER') @Delete('customers/:id') async erase(@Param('id') id: string) {
    const c = await this.prisma.db.customer.findFirst({ where: { id } });
    if (!c) throw new NotFoundException('Customer not found');
    await this.prisma.db.customer.updateMany({ where: { id }, data: { name: 'Erased customer', phone: null, email: null, marketingConsent: false } });
    await this.audit.record({ action: 'customer.erased', entityType: 'Customer', entityId: id });
    return { erased: true };
  }

  // ---- vouchers
  @Roles(...VOUCHER_ROLES) @Post('vouchers') async addVoucher(@Body() dto: VoucherDto) {
    if (dto.kind === 'PERCENT' && dto.value > 100) throw new BadRequestException('A percent voucher cannot exceed 100');
    try {
      const row = await this.prisma.db.voucher.create({
        data: { tenantId: '', code: dto.code.trim().toUpperCase(), kind: dto.kind, value: dto.value, minSubtotal: dto.minSubtotal ?? 0, validFrom: dto.validFrom ? new Date(dto.validFrom) : null, validTo: dto.validTo ? new Date(dto.validTo) : null, maxUses: dto.maxUses ?? null },
      });
      await this.audit.record({ action: 'voucher.created', entityType: 'Voucher', entityId: row.id, after: row });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Voucher code already exists');
      throw e;
    }
  }

  @Roles(...VOUCHER_ROLES) @Get('vouchers') vouchers() {
    return this.prisma.db.voucher.findMany({ orderBy: { code: 'asc' } });
  }

  @Roles(...VOUCHER_ROLES) @Patch('vouchers/:id') async patchVoucher(@Param('id') id: string, @Body() dto: VoucherPatchDto) {
    const res = await this.prisma.db.voucher.updateMany({ where: { id }, data: { active: dto.active } });
    if (!res.count) throw new NotFoundException('Voucher not found');
    await this.audit.record({ action: dto.active ? 'voucher.activated' : 'voucher.deactivated', entityType: 'Voucher', entityId: id });
    return this.prisma.db.voucher.findFirstOrThrow({ where: { id } });
  }

  // ---- gift cards (liability until redeemed)
  @Roles(...ISSUERS) @Post('pos/gift-cards') async issue(@Body() dto: IssueGiftCardDto, @CurrentUser() u: RequestUser) {
    const shift = await this.prisma.db.shift.findFirst({ where: { cashierId: u.id, status: 'OPEN' } });
    if (dto.method === 'CASH' && !shift) throw new BadRequestException('Open a shift before taking cash for a gift card');
    const branchId = shift?.branchId;
    if (branchId) assertBranchAccess(u, branchId, ISSUERS);
    const legalEntityId = branchId
      ? (await this.prisma.db.branch.findFirstOrThrow({ where: { id: branchId } })).legalEntityId
      : (await this.prisma.db.legalEntity.findFirstOrThrow({})).id;
    const amount = money(dto.amount);
    const id = randomUUID();
    const code = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return this.prisma.db.$transaction(async (tx) => {
      const j = await this.posting.post(
        {
          sourceType: 'GiftCard',
          sourceId: id,
          idempotencyKey: `giftcard:${id}`,
          postingDate: ammanToday(),
          memo: `Gift card sale ${code}`,
          legalEntityId,
          branchId: branchId ?? null,
          lines: [{ account: dto.method === 'CASH' ? 'CASH' : 'CARD_CLEARING', debit: amount }, { account: 'GIFT_CARD', credit: amount }],
        },
        tx,
      );
      const card = await tx.giftCard.create({ data: { id, tenantId: '', code, initialAmount: amount, balance: amount, issuedBy: u.id, journalId: j.id } });
      if (dto.method === 'CASH' && shift) {
        await tx.shiftCashEntry.create({ data: { tenantId: '', shiftId: shift.id, kind: 'GIFT_CARD_SALE', amount, refType: 'GiftCard', refId: id, createdBy: u.id } });
      }
      await this.audit.record({ action: 'giftcard.issued', entityType: 'GiftCard', entityId: id, after: { amount: amount.toString(), method: dto.method } }, tx);
      return card;
    });
  }

  @Roles(...ISSUERS) @Get('pos/gift-cards/:code') async balance(@Param('code') code: string) {
    const c = await this.prisma.db.giftCard.findFirst({ where: { code: code.trim().toUpperCase() } });
    if (!c) throw new NotFoundException('Gift card not found');
    return { code: c.code, balance: c.balance, status: c.status };
  }

  @Roles('OWNER', 'FINANCE') @Post('pos/gift-cards/:code/void') async voidCard(@Param('code') code: string) {
    const c = await this.prisma.db.giftCard.findFirst({ where: { code: code.trim().toUpperCase() } });
    if (!c) throw new NotFoundException('Gift card not found');
    if (c.status === 'VOID') return c;
    await this.prisma.db.giftCard.updateMany({ where: { id: c.id }, data: { status: 'VOID' } });
    await this.audit.record({ action: 'giftcard.voided', entityType: 'GiftCard', entityId: c.id, before: { balance: d(c.balance).toString(), status: c.status } });
    return this.prisma.db.giftCard.findFirstOrThrow({ where: { id: c.id } });
  }
}

@Global()
@Module({ controllers: [CustomersController], providers: [VoucherService, GiftCardService, LoyaltyService], exports: [VoucherService, GiftCardService, LoyaltyService] })
export class CustomersModule {}
