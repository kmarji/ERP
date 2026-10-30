-- CreateEnum
CREATE TYPE "TaxReturnStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'AWAITING_AUTHORIZATION', 'APPROVED', 'FILED', 'PAID', 'ARCHIVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "TaxPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReturn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TaxReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "outputBase" DECIMAL(18,3) NOT NULL,
    "outputTax" DECIMAL(18,3) NOT NULL,
    "inputBase" DECIMAL(18,3) NOT NULL,
    "inputTaxRecoverable" DECIMAL(18,3) NOT NULL,
    "inputTaxNonRecoverable" DECIMAL(18,3) NOT NULL,
    "netPayable" DECIMAL(18,3) NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "workingPapers" JSONB NOT NULL DEFAULT '{}',
    "generatedBy" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "authorizedBy" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "filingMethod" TEXT,
    "packageDocId" TEXT,
    "acknowledgmentRef" TEXT,
    "filedAt" TIMESTAMP(3),
    "filedBy" TEXT,
    "paymentRef" TEXT,
    "paymentMethod" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentJournalId" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "TaxReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReturnLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "direction" "TaxDirection" NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "base" DECIMAL(18,3) NOT NULL,
    "tax" DECIMAL(18,3) NOT NULL,
    "documents" INTEGER NOT NULL,

    CONSTRAINT "TaxReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxPeriod_tenantId_legalEntityId_startDate_key" ON "TaxPeriod"("tenantId", "legalEntityId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "TaxReturn_tenantId_periodId_version_key" ON "TaxReturn"("tenantId", "periodId", "version");

-- AddForeignKey
ALTER TABLE "TaxReturn" ADD CONSTRAINT "TaxReturn_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "TaxPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnLine" ADD CONSTRAINT "TaxReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "TaxReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
