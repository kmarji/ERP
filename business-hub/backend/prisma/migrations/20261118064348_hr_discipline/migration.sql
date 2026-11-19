-- CreateEnum
CREATE TYPE "DisciplineStatus" AS ENUM ('REPORTED', 'UNDER_REVIEW', 'EMPLOYEE_RESPONSE', 'DECISION_PENDING', 'APPROVED', 'DISMISSED', 'NOTIFIED', 'APPEALED', 'CLOSED');

-- CreateTable
CREATE TABLE "DisciplinaryCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "incidentDate" DATE NOT NULL,
    "evidenceDocIds" JSONB NOT NULL DEFAULT '[]',
    "reportedBy" TEXT NOT NULL,
    "status" "DisciplineStatus" NOT NULL DEFAULT 'REPORTED',
    "employeeResponse" TEXT,
    "respondedAt" TIMESTAMP(3),
    "sanction" TEXT,
    "fineAmount" DECIMAL(18,3),
    "legalBasis" TEXT,
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "appealText" TEXT,
    "appealOutcome" TEXT,
    "appealDecidedBy" TEXT,
    "expiresAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisciplinaryCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisciplinaryCase_tenantId_employeeId_idx" ON "DisciplinaryCase"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "DisciplinaryCase_tenantId_number_key" ON "DisciplinaryCase"("tenantId", "number");
