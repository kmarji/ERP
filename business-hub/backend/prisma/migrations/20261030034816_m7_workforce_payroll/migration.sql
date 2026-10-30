-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TimeEntryStatus" AS ENUM ('OPEN', 'COMPLETE', 'NEEDS_FIX', 'APPROVED');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'FINALIZED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('HARD', 'SOFT');

-- CreateEnum
CREATE TYPE "OffboardingStatus" AS ENUM ('INITIATED', 'SETTLEMENT_REVIEW', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ShiftTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ShiftTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSwapRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "fromEmployeeId" TEXT NOT NULL,
    "toEmployeeId" TEXT NOT NULL,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "status" "TimeEntryStatus" NOT NULL DEFAULT 'OPEN',
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER NOT NULL DEFAULT 0,
    "workedMinutes" INTEGER,
    "overtimeMinutes" INTEGER,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "correctionOf" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "annualDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "accrualMonthly" BOOLEAN NOT NULL DEFAULT true,
    "requiresCertificateAfterDays" INTEGER,
    "carryOverMax" DECIMAL(6,2),
    "statutory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "accrued" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "used" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "carried" DECIMAL(6,2) NOT NULL DEFAULT 0,

    CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "certificateDocId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRuleSet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "rules" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationNote" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "ruleSetId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "totals" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "journalId" TEXT,
    "bankFileDocId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "paymentJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "basic" DECIMAL(18,3) NOT NULL,
    "allowances" DECIMAL(18,3) NOT NULL,
    "overtimePay" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "otherEarnings" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "lateDeduction" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "unpaidLeaveDeduction" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "gross" DECIMAL(18,3) NOT NULL,
    "sscEmployee" DECIMAL(18,3) NOT NULL,
    "sscEmployer" DECIMAL(18,3) NOT NULL,
    "incomeTax" DECIMAL(18,3) NOT NULL,
    "advances" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,3) NOT NULL,
    "regularHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "trace" JSONB NOT NULL DEFAULT '{}',
    "payslipDocId" TEXT,

    CONSTRAINT "PayrollRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollException" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT,
    "code" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAdvance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "installments" INTEGER NOT NULL,
    "installmentAmount" DECIMAL(18,3) NOT NULL,
    "remaining" DECIMAL(18,3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "approvedBy" TEXT,
    "createdBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "sourceRef" TEXT,
    "appliedRunId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatutoryObligation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(18,3) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "journalId" TEXT,

    CONSTRAINT "StatutoryObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offboarding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "noticeDate" DATE NOT NULL,
    "lastWorkingDay" DATE NOT NULL,
    "status" "OffboardingStatus" NOT NULL DEFAULT 'INITIATED',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "settlement" JSONB,
    "settlementApprovedBy" TEXT,
    "initiatedBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offboarding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftSchedule_tenantId_employeeId_date_idx" ON "ShiftSchedule"("tenantId", "employeeId", "date");

-- CreateIndex
CREATE INDEX "ShiftSchedule_tenantId_branchId_date_idx" ON "ShiftSchedule"("tenantId", "branchId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_tenantId_employeeId_clockIn_idx" ON "TimeEntry"("tenantId", "employeeId", "clockIn");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_tenantId_key_key" ON "LeaveType"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveBalance_employeeId_leaveTypeId_year_key" ON "LeaveBalance"("employeeId", "leaveTypeId", "year");

-- CreateIndex
CREATE INDEX "LeaveRequest_tenantId_employeeId_startDate_idx" ON "LeaveRequest"("tenantId", "employeeId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRuleSet_tenantId_version_key" ON "PayrollRuleSet"("tenantId", "version");

-- CreateIndex
CREATE INDEX "PayrollRun_tenantId_legalEntityId_periodStart_idx" ON "PayrollRun"("tenantId", "legalEntityId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_tenantId_number_key" ON "PayrollRun"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunLine_runId_employeeId_key" ON "PayrollRunLine"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollException_runId_status_idx" ON "PayrollException"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAdjustment_tenantId_sourceRef_key" ON "PayrollAdjustment"("tenantId", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "StatutoryObligation_runId_kind_key" ON "StatutoryObligation"("runId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Offboarding_employeeId_key" ON "Offboarding"("employeeId");

-- AddForeignKey
ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollException" ADD CONSTRAINT "PayrollException_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
