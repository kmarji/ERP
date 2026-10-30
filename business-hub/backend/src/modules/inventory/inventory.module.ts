import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { money } from '../../common/money';
import { Roles } from '../auth/auth.decorators';
import { InventoryOpsController } from './inventory-ops.controller';
import { InventoryOpsService } from './inventory-ops.service';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER')
@Controller('inventory')
class InventoryController {
  constructor(
    private readonly inv: InventoryService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('stock') async stock(@Query('locationId') locationId?: string, @Query('productId') productId?: string) {
    const rows = await this.inv.stock({ locationId, productId });
    const products = await this.prisma.db.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId))] } } });
    const byId = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => ({ ...r, sku: byId.get(r.productId)?.sku, name: byId.get(r.productId)?.name, baseUnit: byId.get(r.productId)?.baseUnit }));
  }

  @Get('valuation') async valuation() {
    const agg = await this.prisma.db.stockBalance.aggregate({ _sum: { value: true } });
    return { totalValue: money(agg._sum.value ?? 0).toString() };
  }

  @Get('movements') movements(
    @Query('productId') productId?: string,
    @Query('locationId') locationId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('sourceId') sourceId?: string,
  ) {
    return this.inv.movements({ productId, locationId, sourceType, sourceId });
  }

  @Get('reconcile') reconcile() {
    return this.inv.reconcile();
  }
}

@Global()
@Module({ controllers: [InventoryController, InventoryOpsController], providers: [InventoryService, InventoryOpsService], exports: [InventoryService, InventoryOpsService] })
export class InventoryModule {}
