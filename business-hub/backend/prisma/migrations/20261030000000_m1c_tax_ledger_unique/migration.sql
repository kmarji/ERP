-- DropIndex
DROP INDEX "TaxLedgerEntry_tenantId_sourceType_sourceId_taxRate_directi_key";

-- CreateIndex
CREATE UNIQUE INDEX "TaxLedgerEntry_tenantId_sourceType_sourceId_taxRate_directi_key" ON "TaxLedgerEntry"("tenantId", "sourceType", "sourceId", "taxRate", "direction", "eligible");

