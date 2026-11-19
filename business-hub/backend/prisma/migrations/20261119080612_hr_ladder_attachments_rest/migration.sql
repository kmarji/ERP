-- AlterTable
ALTER TABLE "ChecklistTemplate" ADD COLUMN     "attachments" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "LibraryItem" ADD COLUMN     "attachments" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "ShiftSchedule" ADD COLUMN     "restOverrideReason" TEXT;

-- CreateTable
CREATE TABLE "DisciplineAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "countsAsWarning" BOOLEAN NOT NULL DEFAULT true,
    "defaultDeduction" DECIMAL(18,3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DisciplineAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisciplineAction_tenantId_key_key" ON "DisciplineAction"("tenantId", "key");
