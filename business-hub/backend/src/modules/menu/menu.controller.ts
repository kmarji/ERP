import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { actorHasRole, currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { MenuService } from './menu.service';

const READERS = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER', 'CASHIER', 'KITCHEN'];
const CATALOG = ['OWNER', 'FINANCE'];
const BRANCH_EDITORS = ['OWNER', 'FINANCE', 'BRANCH_MANAGER'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class CategoryDto {
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

class ItemDto {
  @IsString() sku!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() taxCodeId?: string;
  @IsOptional() @IsString() stationKey?: string;
  @IsOptional() @IsBoolean() isCombo?: boolean;
  @IsOptional() @Matches(HHMM) availableFrom?: string;
  @IsOptional() @Matches(HHMM) availableTo?: string;
}

// Price is deliberately absent: it only changes through the policy-gated /price endpoint.
class ItemPatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() taxCodeId?: string;
  @IsOptional() @IsString() stationKey?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Matches(HHMM) availableFrom?: string;
  @IsOptional() @Matches(HHMM) availableTo?: string;
}

class PriceDto {
  @IsNumber() @Min(0) price!: number;
}

class VariantDto {
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsNumber() priceDelta?: number;
  @IsOptional() @IsNumber() @Min(0.0001) recipeScale?: number;
}

class GroupDto {
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsInt() @Min(0) minSelect?: number;
  @IsOptional() @IsInt() @Min(1) maxSelect?: number;
}

class ModifierDto {
  @IsString() name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsNumber() priceDelta?: number;
}

class ModifierIngredientDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0) qtyBase!: number;
}

class LinkGroupDto {
  @IsString() groupId!: string;
}

class ComponentDto {
  @IsString() componentItemId!: string;
  @IsOptional() @IsInt() @Min(1) qty?: number;
}

class RecipeIngredientDto {
  @IsString() productId!: string;
  @IsNumber() @Min(0) qtyBase!: number;
}

class RecipeDto {
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsNumber() @Min(0.001) yield?: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => RecipeIngredientDto) ingredients!: RecipeIngredientDto[];
}

class BranchOverrideDto {
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsBoolean() available?: boolean;
}

@ApiTags('menu')
@ApiBearerAuth()
@Roles(...READERS)
@Controller('menu')
class MenuController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  private async item(id: string) {
    const i = await this.prisma.db.menuItem.findFirst({ where: { id } });
    if (!i) throw new NotFoundException('Menu item not found');
    return i;
  }

  // ------------------------------------------------------------ categories and items

  @Get('categories') categories() {
    return this.prisma.db.menuCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Roles(...CATALOG) @Post('categories') async addCategory(@Body() dto: CategoryDto) {
    const row = await this.prisma.db.menuCategory.create({ data: { tenantId: '', ...dto } });
    await this.audit.record({ action: 'menu.category_created', entityType: 'MenuCategory', entityId: row.id, after: row });
    return row;
  }

  @Get('items') async items(@Query('branchId') branchId?: string) {
    const items = await this.prisma.db.menuItem.findMany({
      include: { variants: true, components: true, modifierGroups: { include: { group: { include: { modifiers: true } } } } },
      orderBy: { sku: 'asc' },
    });
    if (!branchId) return items;
    const ov = new Map((await this.prisma.db.branchMenuItem.findMany({ where: { branchId } })).map((o) => [o.menuItemId, o]));
    return items.map((i) => ({ ...i, effectivePrice: money(ov.get(i.id)?.price ?? i.price).toString(), available: i.active && (ov.get(i.id)?.available ?? true) }));
  }

  @Get('items/:id') async itemDetail(@Param('id') id: string) {
    const i = await this.prisma.db.menuItem.findFirst({
      where: { id },
      include: { variants: true, components: true, modifierGroups: { include: { group: { include: { modifiers: { include: { ingredients: true } } } } } } },
    });
    if (!i) throw new NotFoundException('Menu item not found');
    return i;
  }

  @Roles(...CATALOG) @Post('items') async addItem(@Body() dto: ItemDto) {
    const row = await this.prisma.db.menuItem.create({ data: { tenantId: '', ...dto, price: money(dto.price) } });
    await this.audit.record({ action: 'menu.item_created', entityType: 'MenuItem', entityId: row.id, after: row });
    return row;
  }

  @Roles(...CATALOG) @Patch('items/:id') async patchItem(@Param('id') id: string, @Body() dto: ItemPatchDto) {
    const before = await this.item(id);
    await this.prisma.db.menuItem.updateMany({ where: { id }, data: dto });
    await this.audit.record({ action: 'menu.item_updated', entityType: 'MenuItem', entityId: id, before, after: dto });
    return this.item(id);
  }

  @Roles(...CATALOG) @Patch('items/:id/price') price(@Param('id') id: string, @Body() dto: PriceDto, @CurrentUser() u: RequestUser) {
    return this.menu.changePrice(id, dto.price, u);
  }

  @Get('price-changes') priceChanges() {
    return this.prisma.db.priceChange.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  // ------------------------------------------------------------ variants, modifiers, combos

  @Roles(...CATALOG) @Post('items/:id/variants') async addVariant(@Param('id') id: string, @Body() dto: VariantDto) {
    await this.item(id);
    const row = await this.prisma.db.menuItemVariant.create({ data: { tenantId: '', menuItemId: id, ...dto } });
    await this.audit.record({ action: 'menu.variant_created', entityType: 'MenuItem', entityId: id, after: row });
    return row;
  }

  @Get('modifier-groups') groups() {
    return this.prisma.db.modifierGroup.findMany({ include: { modifiers: { include: { ingredients: true } } } });
  }

  @Roles(...CATALOG) @Post('modifier-groups') async addGroup(@Body() dto: GroupDto) {
    const minSelect = dto.minSelect ?? 0;
    const maxSelect = dto.maxSelect ?? Math.max(1, minSelect);
    if (maxSelect < minSelect) throw new BadRequestException('maxSelect must be >= minSelect');
    const row = await this.prisma.db.modifierGroup.create({ data: { tenantId: '', name: dto.name, nameAr: dto.nameAr, minSelect, maxSelect } });
    await this.audit.record({ action: 'menu.modifier_group_created', entityType: 'ModifierGroup', entityId: row.id, after: row });
    return row;
  }

  @Roles(...CATALOG) @Post('modifier-groups/:id/modifiers') async addModifier(@Param('id') id: string, @Body() dto: ModifierDto) {
    const g = await this.prisma.db.modifierGroup.findFirst({ where: { id } });
    if (!g) throw new NotFoundException('Modifier group not found');
    const row = await this.prisma.db.modifier.create({ data: { tenantId: '', groupId: id, ...dto } });
    await this.audit.record({ action: 'menu.modifier_created', entityType: 'Modifier', entityId: row.id, after: row });
    return row;
  }

  @Roles(...CATALOG) @Post('modifiers/:id/ingredients') async addModifierIngredient(@Param('id') id: string, @Body() dto: ModifierIngredientDto) {
    const m = await this.prisma.db.modifier.findFirst({ where: { id } });
    if (!m) throw new NotFoundException('Modifier not found');
    return this.prisma.db.modifierIngredient.create({ data: { tenantId: '', modifierId: id, ...dto } });
  }

  @Roles(...CATALOG) @Post('items/:id/modifier-groups') async linkGroup(@Param('id') id: string, @Body() dto: LinkGroupDto) {
    await this.item(id);
    const g = await this.prisma.db.modifierGroup.findFirst({ where: { id: dto.groupId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    return this.prisma.db.menuItemModifierGroup.create({ data: { tenantId: '', menuItemId: id, groupId: dto.groupId } });
  }

  @Roles(...CATALOG) @Post('items/:id/components') async addComponent(@Param('id') id: string, @Body() dto: ComponentDto) {
    const combo = await this.item(id);
    if (!combo.isCombo) throw new BadRequestException('Item is not a combo');
    if (dto.componentItemId === id) throw new BadRequestException('A combo cannot contain itself');
    await this.item(dto.componentItemId);
    return this.prisma.db.comboComponent.create({ data: { tenantId: '', comboItemId: id, componentItemId: dto.componentItemId, qty: dto.qty ?? 1 } });
  }

  // ------------------------------------------------------------ recipes

  @Get('items/:id/recipe') async recipe(@Param('id') id: string, @Query('variantId') variantId?: string) {
    return this.prisma.db.recipe.findFirst({ where: { menuItemId: id, variantKey: variantId ?? '' }, include: { ingredients: true } });
  }

  @Roles(...CATALOG) @Put('items/:id/recipe') async putRecipe(@Param('id') id: string, @Body() dto: RecipeDto) {
    await this.item(id);
    const variantKey = dto.variantId ?? '';
    if (dto.variantId) {
      const v = await this.prisma.db.menuItemVariant.findFirst({ where: { id: dto.variantId, menuItemId: id } });
      if (!v) throw new BadRequestException('Variant does not belong to this item');
    }
    const row = await this.prisma.db.$transaction(async (tx) => {
      await tx.recipe.deleteMany({ where: { menuItemId: id, variantKey } });
      const r = await tx.recipe.create({
        data: {
          tenantId: '',
          menuItemId: id,
          variantKey,
          yield: dto.yield ?? 1,
          ingredients: { create: dto.ingredients.map((i) => ({ tenantId: currentTenantId(), productId: i.productId, qtyBase: i.qtyBase })) },
        },
        include: { ingredients: true },
      });
      await this.audit.record({ action: 'menu.recipe_saved', entityType: 'MenuItem', entityId: id, after: { variantKey, yield: dto.yield ?? 1, ingredients: dto.ingredients } }, tx);
      return r;
    });
    return row;
  }

  // ------------------------------------------------------------ branch overrides and availability

  // Out-of-stock toggles are open to kitchen staff; price overrides go through the same policy gate as central prices.
  @Roles(...BRANCH_EDITORS, 'KITCHEN') @Put('branches/:branchId/items/:itemId')
  async branchOverride(@Param('branchId') branchId: string, @Param('itemId') itemId: string, @Body() dto: BranchOverrideDto, @CurrentUser() u: RequestUser) {
    assertBranchAccess(u, branchId, [...BRANCH_EDITORS, 'KITCHEN']);
    if (dto.price === undefined && dto.available === undefined) throw new BadRequestException('Provide price and/or available');
    await this.item(itemId);
    const branch = await this.prisma.db.branch.findFirst({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('Branch not found');

    let priceResult: { change: unknown; applied: boolean } | undefined;
    if (dto.price !== undefined) {
      if (!BRANCH_EDITORS.some((r) => actorHasRole(u, r, { branchId }))) throw new ForbiddenException('Only managers and finance can change prices');
      priceResult = await this.menu.changePrice(itemId, dto.price, u, branchId);
    }
    if (dto.available !== undefined) {
      const res = await this.prisma.db.branchMenuItem.updateMany({ where: { branchId, menuItemId: itemId }, data: { available: dto.available } });
      if (res.count === 0) await this.prisma.db.branchMenuItem.create({ data: { tenantId: '', branchId, menuItemId: itemId, available: dto.available } });
      await this.audit.record({ action: dto.available ? 'menu.item_available' : 'menu.item_86', entityType: 'MenuItem', entityId: itemId, after: { branchId, available: dto.available } });
      // Marketplaces and online channels must stop selling what the kitchen has run out of.
      this.events.emit('menu.availability_changed', { tenantId: currentTenantId(), branchId, menuItemId: itemId, available: dto.available });
    }
    return { override: await this.prisma.db.branchMenuItem.findFirst({ where: { branchId, menuItemId: itemId } }), priceChange: priceResult };
  }

  @Roles(...BRANCH_EDITORS) @Get('costing') costing(@Query('branchId') branchId?: string) {
    return this.menu.costing(branchId);
  }

  @Get('offline-bundle/:branchId') bundle(@Param('branchId') branchId: string) {
    return this.menu.offlineBundle(branchId);
  }
}

export { MenuController };
