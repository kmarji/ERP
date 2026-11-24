-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "managerId" TEXT;

-- CreateTable
CREATE TABLE "EmployeeLetter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "addressee" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "number" TEXT,
    "content" JSONB,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeLetter_tenantId_employeeId_idx" ON "EmployeeLetter"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "EmployeeLetter_tenantId_status_idx" ON "EmployeeLetter"("tenantId", "status");
