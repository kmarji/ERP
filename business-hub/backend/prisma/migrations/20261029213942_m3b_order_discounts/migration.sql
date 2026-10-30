-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discounts" JSONB NOT NULL DEFAULT '[]';
