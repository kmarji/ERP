-- CreateEnum
CREATE TYPE "AggregatorProvider" AS ENUM ('TALABAT', 'CAREEM');

-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('RECEIVED', 'NEEDS_MAPPING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'ERROR');

-- AlterEnum
ALTER TYPE "TenderMethod" ADD VALUE 'MARKETPLACE';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "contact" JSONB,
ADD COLUMN     "fulfilmentStatus" TEXT,
ADD COLUMN     "promisedAt" TIMESTAMP(3),
ADD COLUMN     "trackingCode" TEXT;

-- CreateTable
CREATE TABLE "OnlineStoreConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "acceptingOrders" BOOLEAN NOT NULL DEFAULT true,
    "pickupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deliveryFee" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "minOrder" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "serviceAreas" JSONB NOT NULL DEFAULT '[]',
    "prepMinutes" INTEGER NOT NULL DEFAULT 20,
    "autoAccept" BOOLEAN NOT NULL DEFAULT false,
    "scheduledOrdering" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineStoreConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "branchId" TEXT NOT NULL,
    "storeRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoAccept" BOOLEAN NOT NULL DEFAULT true,
    "commissionRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "webhookSecretHash" TEXT,
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AggregatorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorMenuMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalItemId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "variantId" TEXT,
    "modifierMap" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AggregatorMenuMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorInbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "orderId" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AggregatorInbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineStoreConfig_tenantId_branchId_key" ON "OnlineStoreConfig"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorConnection_tenantId_provider_storeRef_key" ON "AggregatorConnection"("tenantId", "provider", "storeRef");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorMenuMapping_connectionId_externalItemId_key" ON "AggregatorMenuMapping"("connectionId", "externalItemId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorInbound_connectionId_externalId_key" ON "AggregatorInbound"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "AggregatorMenuMapping" ADD CONSTRAINT "AggregatorMenuMapping_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorInbound" ADD CONSTRAINT "AggregatorInbound_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
