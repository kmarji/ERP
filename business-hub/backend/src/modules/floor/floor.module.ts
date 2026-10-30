import { ConflictException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, BadRequestException, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsInt, IsString, Min } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';

const WRITE = ['OWNER', 'BRANCH_MANAGER'] as const;
const READ = [...WRITE, 'CASHIER', 'KITCHEN'] as const;

class PlanDto {
  @IsString() branchId!: string;
  @IsString() name!: string;
}

class TableDto {
  @IsString() name!: string;
  @IsInt() @Min(1) seats!: number;
}

@ApiTags('floor')
@ApiBearerAuth()
@Controller('floor')
class FloorController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Roles(...WRITE) @Post('plans') async addPlan(@Body() dto: PlanDto, @CurrentUser() u: RequestUser) {
    assertBranchAccess(u, dto.branchId, WRITE);
    const row = await this.prisma.db.floorPlan.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'floor_plan.created', entityType: 'FloorPlan', entityId: row.id, after: row });
    return row;
  }

  @Roles(...READ) @Get('plans') plans(@Query('branchId') branchId: string, @CurrentUser() u: RequestUser) {
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAccess(u, branchId, READ);
    return this.prisma.db.floorPlan.findMany({ where: { branchId }, include: { tables: { orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } });
  }

  @Roles(...WRITE) @Post('plans/:id/tables') async addTable(@Param('id') id: string, @Body() dto: TableDto, @CurrentUser() u: RequestUser) {
    const plan = await this.prisma.db.floorPlan.findFirst({ where: { id } });
    if (!plan) throw new NotFoundException('Floor plan not found');
    assertBranchAccess(u, plan.branchId, WRITE);
    try {
      return await this.prisma.db.diningTable.create({ data: { tenantId: '', floorPlanId: id, branchId: plan.branchId, name: dto.name, seats: dto.seats } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A table with this name already exists at the branch');
      throw e;
    }
  }

  @Roles(...WRITE) @Delete('tables/:id') async removeTable(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    const t = await this.prisma.db.diningTable.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('Table not found');
    assertBranchAccess(u, t.branchId, WRITE);
    await this.prisma.db.diningTable.deleteMany({ where: { id } });
    await this.audit.record({ action: 'table.removed', entityType: 'DiningTable', entityId: id, before: t });
    return { deleted: true };
  }

  @Roles(...READ) @Get('tables') async tables(@Query('branchId') branchId: string, @CurrentUser() u: RequestUser) {
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAccess(u, branchId, READ);
    const tables = await this.prisma.db.diningTable.findMany({ where: { branchId }, orderBy: { name: 'asc' } });
    const open = await this.prisma.db.order.findMany({ where: { branchId, tableId: { in: tables.map((t) => t.id) }, status: { in: ['OPEN', 'SENT'] } }, select: { id: true, number: true, tableId: true } });
    return tables.map((t) => {
      const o = open.find((x) => x.tableId === t.id);
      return { ...t, openOrderId: o?.id ?? null, openOrderNumber: o?.number ?? null };
    });
  }
}

@Module({ controllers: [FloorController] })
export class FloorModule {}
