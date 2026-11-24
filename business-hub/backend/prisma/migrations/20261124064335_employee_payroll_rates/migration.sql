-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "incomeTaxRate" DECIMAL(7,6),
ADD COLUMN     "incomeTaxRateNote" TEXT,
ADD COLUMN     "sscEmployeeRate" DECIMAL(7,6),
ADD COLUMN     "sscEmployerRate" DECIMAL(7,6),
ADD COLUMN     "sscRateNote" TEXT;
