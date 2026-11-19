-- CreateTable
CREATE TABLE "AuditTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "branchId" TEXT,
    "items" JSONB NOT NULL,
    "passPercent" INTEGER NOT NULL DEFAULT 80,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "auditorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "results" JSONB,
    "scorePct" INTEGER,
    "passed" BOOLEAN,
    "criticalFails" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AuditRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodSafetyPoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'C',
    "minValue" DECIMAL(8,2),
    "maxValue" DECIMAL(8,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FoodSafetyPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodSafetyReading" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pointId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "value" DECIMAL(8,2) NOT NULL,
    "inRange" BOOLEAN NOT NULL,
    "takenBy" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "docId" TEXT,
    "actionId" TEXT,

    CONSTRAINT "FoodSafetyReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectiveAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeEmployeeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "overdueAt" TIMESTAMP(3),
    "completionNote" TEXT,
    "evidenceDocIds" JSONB NOT NULL DEFAULT '[]',
    "completedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrectiveAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditTemplate_tenantId_code_version_key" ON "AuditTemplate"("tenantId", "code", "version");

-- CreateIndex
CREATE INDEX "AuditRecord_tenantId_branchId_status_idx" ON "AuditRecord"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "FoodSafetyPoint_tenantId_branchId_idx" ON "FoodSafetyPoint"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "FoodSafetyReading_tenantId_pointId_takenAt_idx" ON "FoodSafetyReading"("tenantId", "pointId", "takenAt");

-- CreateIndex
CREATE INDEX "CorrectiveAction_tenantId_branchId_status_idx" ON "CorrectiveAction"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "CorrectiveAction_tenantId_source_sourceId_idx" ON "CorrectiveAction"("tenantId", "source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectiveAction_tenantId_number_key" ON "CorrectiveAction"("tenantId", "number");
