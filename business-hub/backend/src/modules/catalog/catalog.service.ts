import { BadRequestException, Injectable } from '@nestjs/common';
import { Decimal, d } from '../../common/money';
import { PrismaService, ScopedClient } from '../../common/prisma/prisma.service';

type Db = Pick<ScopedClient, 'product' | 'supplierItem'>;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // Factor that converts 1 <unit> of the product into its base unit.
  async unitFactor(productId: string, unit: string, db: Db = this.prisma.db): Promise<Decimal> {
    const p = await db.product.findFirst({ where: { id: productId }, include: { conversions: true } });
    if (!p) throw new BadRequestException(`Unknown product ${productId}`);
    if (unit === p.baseUnit) return d(1);
    const c = p.conversions.find((x) => x.unit === unit);
    if (!c) throw new BadRequestException(`No conversion from '${unit}' to base unit '${p.baseUnit}' for ${p.sku}`);
    return d(c.factorToBase);
  }

  // Resolve a supplier's own SKU to an internal product; null when unmapped.
  async mapSupplierSku(supplierId: string, supplierSku: string, db: Db = this.prisma.db) {
    return db.supplierItem.findFirst({ where: { supplierId, supplierSku }, include: { product: true } });
  }
}
