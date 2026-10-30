-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('INGREDIENT', 'SUPPLY', 'MENU_ITEM');

-- CreateEnum
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CONVERTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('PENDING_APPROVAL', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('CAPTURED', 'EXCEPTION', 'POSTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('RECEIPT', 'SALE_CONSUMPTION', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'WASTAGE', 'COUNT_ADJUSTMENT', 'RETURN_TO_SUPPLIER');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'LOCKED');

-- CreateEnum
CREATE TYPE "TaxDirection" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('OPEN', 'PAYMENT_APPROVED', 'PAID');

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "kind" "ProductKind" NOT NULL DEFAULT 'INGREDIENT',
    "baseUnit" TEXT NOT NULL,
    "category" TEXT,
    "taxCodeId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitConversion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "factorToBase" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "UnitConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxNumber" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "agreedPrice" DECIMAL(18,4),
    "preferred" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupplierItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "stockLocationId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "supplierId" TEXT,
    "estUnitPrice" DECIMAL(18,4),

    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "stockLocationId" TEXT NOT NULL,
    "purchaseRequestId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "subtotal" DECIMAL(18,3) NOT NULL,
    "taxTotal" DECIMAL(18,3) NOT NULL,
    "total" DECIMAL(18,3) NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "qtyReceived" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineNet" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "subtotal" DECIMAL(18,3) NOT NULL,
    "taxTotal" DECIMAL(18,3) NOT NULL,
    "total" DECIMAL(18,3) NOT NULL,
    "supplierTaxNumber" TEXT,
    "qrUuid" TEXT,
    "qrPayload" TEXT,
    "purchaseOrderId" TEXT,
    "evidenceDocumentId" TEXT,
    "extractionConfidence" DECIMAL(5,4),
    "status" "InvoiceStatus" NOT NULL DEFAULT 'CAPTURED',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "duplicateKey" TEXT,
    "journalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "description" TEXT,
    "productId" TEXT,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "lineNet" DECIMAL(18,3) NOT NULL,
    "lineTax" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "supplierId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "stockLocationId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "operationalStatus" "ReceiptStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'PENDING',
    "journalId" TEXT,
    "receivedBy" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "poLineId" TEXT,
    "productId" TEXT NOT NULL,
    "qtyReceived" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "valueDelta" DECIMAL(18,3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "journalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "qtyBase" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "value" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "avgCost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "type" "AccountType" NOT NULL,
    "systemKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChartAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialPeriod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),

    CONSTRAINT "FinancialPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Journal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "postingDate" DATE NOT NULL,
    "memo" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "branchId" TEXT,
    "reversalOfId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "costCenterId" TEXT,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "TaxDirection" NOT NULL,
    "rate" DECIMAL(6,4) NOT NULL,
    "eligibleDefault" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" "TaxDirection" NOT NULL,
    "taxCodeId" TEXT,
    "taxRate" DECIMAL(6,4) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "base" DECIMAL(18,3) NOT NULL,
    "taxAmount" DECIMAL(18,3) NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "legalEntityId" TEXT NOT NULL,
    "journalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "amountDue" DECIMAL(18,3) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'OPEN',
    "approvedBy" TEXT,
    "paymentReference" TEXT,
    "paymentMethod" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_tenantId_key_key" ON "Sequence"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "UnitConversion_productId_unit_key" ON "UnitConversion"("productId", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_taxNumber_key" ON "Supplier"("tenantId", "taxNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierItem_tenantId_supplierId_supplierSku_key" ON "SupplierItem"("tenantId", "supplierId", "supplierSku");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_tenantId_number_key" ON "PurchaseRequest"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_number_key" ON "PurchaseOrder"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_purchaseRequestId_supplierId_key" ON "PurchaseOrder"("tenantId", "purchaseRequestId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_tenantId_supplierId_invoiceNumber_idx" ON "SupplierInvoice"("tenantId", "supplierId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_duplicateKey_key" ON "SupplierInvoice"("tenantId", "duplicateKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_tenantId_qrUuid_key" ON "SupplierInvoice"("tenantId", "qrUuid");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_number_key" ON "GoodsReceipt"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_idempotencyKey_key" ON "GoodsReceipt"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_productId_locationId_idx" ON "StockMovement"("tenantId", "productId", "locationId");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_sourceType_sourceId_idx" ON "StockMovement"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_tenantId_idempotencyKey_key" ON "StockMovement"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_tenantId_productId_locationId_key" ON "StockBalance"("tenantId", "productId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChartAccount_tenantId_code_key" ON "ChartAccount"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ChartAccount_tenantId_systemKey_key" ON "ChartAccount"("tenantId", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialPeriod_tenantId_startDate_key" ON "FinancialPeriod"("tenantId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "Journal_reversalOfId_key" ON "Journal"("reversalOfId");

-- CreateIndex
CREATE INDEX "Journal_tenantId_sourceType_sourceId_idx" ON "Journal"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Journal_tenantId_postingDate_idx" ON "Journal"("tenantId", "postingDate");

-- CreateIndex
CREATE UNIQUE INDEX "Journal_tenantId_number_key" ON "Journal"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Journal_tenantId_idempotencyKey_key" ON "Journal"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JournalLine_tenantId_accountId_idx" ON "JournalLine"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCode_tenantId_code_key" ON "TaxCode"("tenantId", "code");

-- CreateIndex
CREATE INDEX "TaxLedgerEntry_tenantId_direction_documentDate_idx" ON "TaxLedgerEntry"("tenantId", "direction", "documentDate");

-- CreateIndex
CREATE UNIQUE INDEX "TaxLedgerEntry_tenantId_sourceType_sourceId_taxRate_directi_key" ON "TaxLedgerEntry"("tenantId", "sourceType", "sourceId", "taxRate", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "Payable_invoiceId_key" ON "Payable"("invoiceId");

-- CreateIndex
CREATE INDEX "Payable_tenantId_status_dueDate_idx" ON "Payable"("tenantId", "status", "dueDate");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxCodeId_fkey" FOREIGN KEY ("taxCodeId") REFERENCES "TaxCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitConversion" ADD CONSTRAINT "UnitConversion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journal" ADD CONSTRAINT "Journal_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "Journal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defense in depth: finalized accounting, audit and stock history can never be updated or deleted,
-- even by code that bypasses the application layer. Corrections are new reversing rows.
CREATE OR REPLACE FUNCTION bh_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed (create a reversing entry instead)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON "Journal" FOR EACH ROW EXECUTE FUNCTION bh_forbid_mutation();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION bh_forbid_mutation();
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION bh_forbid_mutation();
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION bh_forbid_mutation();
