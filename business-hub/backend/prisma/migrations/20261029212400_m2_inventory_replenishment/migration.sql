-- CreateEnum
CREATE TYPE "CountStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WastageStatus" AS ENUM ('RECORDED', 'UNDER_REVIEW');

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "CountStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "journalId" TEXT,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "countedQtyBase" DECIMAL(18,4),
    "expectedQtyBase" DECIMAL(18,4),
    "varianceQty" DECIMAL(18,4),
    "varianceValue" DECIMAL(18,3),

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wastage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "value" DECIMAL(18,3) NOT NULL,
    "status" "WastageStatus" NOT NULL DEFAULT 'RECORDED',
    "journalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wastage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "journalId" TEXT,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "minQtyBase" DECIMAL(18,4) NOT NULL,
    "maxQtyBase" DECIMAL(18,4) NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 2,
    "supplierId" TEXT,
    "orderUnit" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReplenishmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_tenantId_number_key" ON "StockCount"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_productId_key" ON "StockCountLine"("countId", "productId");

-- CreateIndex
CREATE INDEX "Wastage_tenantId_createdAt_idx" ON "Wastage"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_number_key" ON "StockTransfer"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ReplenishmentRule_tenantId_productId_locationId_key" ON "ReplenishmentRule"("tenantId", "productId", "locationId");

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
