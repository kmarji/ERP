-- CreateEnum
CREATE TYPE "PriceChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'VOID');

-- CreateEnum
CREATE TYPE "OfflineStatus" AS ENUM ('APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY', 'ONLINE', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'SENT', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "ExternalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TenderMethod" AS ENUM ('CASH', 'CARD', 'DIGITAL', 'GIFT_CARD');

-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('AUTHORIZED', 'CAPTURED', 'FAILED', 'VOIDED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'READY', 'BUMPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('MATCHED', 'EXCEPTION');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'SALE_RETURN';

-- AlterTable
ALTER TABLE "StockLocation" ADD COLUMN     "isSalesLocation" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "categoryId" TEXT,
    "price" DECIMAL(18,3) NOT NULL,
    "taxCodeId" TEXT,
    "stationKey" TEXT,
    "isCombo" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "availableFrom" TEXT,
    "availableTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "priceDelta" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "recipeScale" DECIMAL(8,4) NOT NULL DEFAULT 1,

    CONSTRAINT "MenuItemVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Modifier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "priceDelta" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierIngredient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "ModifierIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItemModifierGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "MenuItemModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboComponent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "comboItemId" TEXT NOT NULL,
    "componentItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ComboComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL DEFAULT '',
    "yield" DECIMAL(10,3) NOT NULL DEFAULT 1,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchMenuItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" DECIMAL(18,3),
    "available" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BranchMenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "branchId" TEXT,
    "oldPrice" DECIMAL(18,3) NOT NULL,
    "newPrice" DECIMAL(18,3) NOT NULL,
    "pct" DECIMAL(10,4) NOT NULL,
    "status" "PriceChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "FloorPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiningTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "floorPlanId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 4,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "VoucherKind" NOT NULL,
    "value" DECIMAL(18,3) NOT NULL,
    "minSubtotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherRedemption" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "initialAmount" DECIMAL(18,3) NOT NULL,
    "balance" DECIMAL(18,3) NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedBy" TEXT NOT NULL,
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "enrolledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OfflineStatus" NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "deviceId" TEXT,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openingFloat" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "expectedCash" DECIMAL(18,3),
    "countedCash" DECIMAL(18,3),
    "variance" DECIMAL(18,3),
    "journalId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftCashEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftCashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT,
    "tableId" TEXT,
    "channel" "OrderChannel" NOT NULL DEFAULT 'DINE_IN',
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NONE',
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "externalStatus" "ExternalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "customerId" TEXT,
    "guestCount" INTEGER,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'POS',
    "externalRef" TEXT,
    "subtotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "refundedTotal" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "journalId" TEXT,
    "cogsJournalId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,3) NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "gross" DECIMAL(18,3) NOT NULL,
    "discount" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,3) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "tax" DECIMAL(18,3) NOT NULL,
    "net" DECIMAL(18,3) NOT NULL,
    "stationKey" TEXT,
    "notes" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voidReason" TEXT,
    "refundedQty" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shiftId" TEXT,
    "method" "TenderMethod" NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "tendered" DECIMAL(18,3) NOT NULL,
    "change" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "status" "TenderStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "reference" TEXT,
    "settlementId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(18,3) NOT NULL,
    "discountTotal" DECIMAL(18,3) NOT NULL,
    "taxTotal" DECIMAL(18,3) NOT NULL,
    "total" DECIMAL(18,3) NOT NULL,
    "externalStatus" "ExternalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "externalRef" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "total" DECIMAL(18,3) NOT NULL,
    "tax" DECIMAL(18,3) NOT NULL,
    "net" DECIMAL(18,3) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "journalId" TEXT,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "total" DECIMAL(18,3) NOT NULL,
    "tax" DECIMAL(18,3) NOT NULL,
    "net" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "bumpedAt" TIMESTAMP(3),

    CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "settlementDate" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "gross" DECIMAL(18,3) NOT NULL,
    "fees" DECIMAL(18,3) NOT NULL,
    "net" DECIMAL(18,3) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'EXCEPTION',
    "journalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "tenderId" TEXT,
    "orderId" TEXT,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Station_tenantId_branchId_key_key" ON "Station"("tenantId", "branchId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_tenantId_sku_key" ON "MenuItem"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemModifierGroup_menuItemId_groupId_key" ON "MenuItemModifierGroup"("menuItemId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_menuItemId_variantKey_key" ON "Recipe"("menuItemId", "variantKey");

-- CreateIndex
CREATE UNIQUE INDEX "BranchMenuItem_branchId_menuItemId_key" ON "BranchMenuItem"("branchId", "menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorPlan_tenantId_branchId_name_key" ON "FloorPlan"("tenantId", "branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_tenantId_branchId_name_key" ON "DiningTable"("tenantId", "branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_phone_key" ON "Customer"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_tenantId_customerId_idx" ON "LoyaltyTransaction"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_tenantId_code_key" ON "Voucher"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemption_orderId_key" ON "VoucherRedemption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_tenantId_code_key" ON "GiftCard"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineOperation_tenantId_deviceId_opId_key" ON "OfflineOperation"("tenantId", "deviceId", "opId");

-- CreateIndex
CREATE INDEX "Shift_tenantId_branchId_status_idx" ON "Shift"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "ShiftCashEntry_shiftId_idx" ON "ShiftCashEntry"("shiftId");

-- CreateIndex
CREATE INDEX "Order_tenantId_branchId_status_idx" ON "Order"("tenantId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_number_key" ON "Order"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_idempotencyKey_key" ON "Order"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "Tender_tenantId_method_status_idx" ON "Tender"("tenantId", "method", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Tender_tenantId_idempotencyKey_key" ON "Tender"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_number_key" ON "Refund"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_idempotencyKey_key" ON "Refund"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "KitchenTicket_tenantId_branchId_status_idx" ON "KitchenTicket"("tenantId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_tenantId_provider_reference_key" ON "Settlement"("tenantId", "provider", "reference");

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierIngredient" ADD CONSTRAINT "ModifierIngredient_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemModifierGroup" ADD CONSTRAINT "MenuItemModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_comboItemId_fkey" FOREIGN KEY ("comboItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchMenuItem" ADD CONSTRAINT "BranchMenuItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiningTable" ADD CONSTRAINT "DiningTable_floorPlanId_fkey" FOREIGN KEY ("floorPlanId") REFERENCES "FloorPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftCashEntry" ADD CONSTRAINT "ShiftCashEntry_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
