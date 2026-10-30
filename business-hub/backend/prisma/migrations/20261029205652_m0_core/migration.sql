-- CreateEnum
CREATE TYPE "RiskTier" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'REGULATED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('DETECTED', 'CLASSIFIED', 'ASSIGNED', 'NOTIFIED', 'RESOLVED', 'APPROVED', 'REJECTED', 'EXECUTED', 'RETRIED', 'VERIFIED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('RECORDED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxNumber" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'JOD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "branchId" TEXT,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "branchId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "riskTier" "RiskTier" NOT NULL DEFAULT 'MEDIUM',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLimit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "maxAmount" DECIMAL(18,3) NOT NULL,
    "legalEntityId" TEXT,
    "branchId" TEXT,
    "category" TEXT,

    CONSTRAINT "ApprovalLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "riskTier" "RiskTier" NOT NULL DEFAULT 'LOW',
    "correlationId" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT,
    "title" TEXT NOT NULL,
    "assigneeRole" TEXT,
    "assigneeUserId" TEXT,
    "branchId" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exception" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT,
    "code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "impact" TEXT,
    "amount" DECIMAL(18,3),
    "riskTier" "RiskTier" NOT NULL DEFAULT 'MEDIUM',
    "status" "ExceptionStatus" NOT NULL DEFAULT 'DETECTED',
    "ownerRole" TEXT,
    "ownerUserId" TEXT,
    "branchId" TEXT,
    "deadline" TIMESTAMP(3),
    "availableActions" JSONB NOT NULL DEFAULT '[]',
    "escalationRoute" JSONB NOT NULL DEFAULT '[]',
    "ownerEscalated" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "exceptionId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "amount" DECIMAL(18,3),
    "requestedBy" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approverUserId" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "roleKey" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "extracted" JSONB,
    "confidence" DECIMAL(5,4),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'RECORDED',
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "policyVersion" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
    "externalResponse" JSONB,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "LegalEntity_tenantId_idx" ON "LegalEntity"("tenantId");

-- CreateIndex
CREATE INDEX "Branch_legalEntityId_idx" ON "Branch"("legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_code_key" ON "Branch"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_tenantId_code_key" ON "CostCenter"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_tenantId_code_key" ON "StockLocation"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_key_key" ON "Role"("tenantId", "key");

-- CreateIndex
CREATE INDEX "UserRole_tenantId_userId_idx" ON "UserRole"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Delegation_tenantId_toUserId_idx" ON "Delegation"("tenantId", "toUserId");

-- CreateIndex
CREATE INDEX "Policy_tenantId_key_active_idx" ON "Policy"("tenantId", "key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_tenantId_key_version_key" ON "Policy"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "ApprovalLimit_tenantId_policyKey_idx" ON "ApprovalLimit"("tenantId", "policyKey");

-- CreateIndex
CREATE INDEX "WorkflowInstance_tenantId_definitionKey_state_idx" ON "WorkflowInstance"("tenantId", "definitionKey", "state");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_tenantId_definitionKey_subjectType_subject_key" ON "WorkflowInstance"("tenantId", "definitionKey", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Task_tenantId_status_assigneeRole_idx" ON "Task"("tenantId", "status", "assigneeRole");

-- CreateIndex
CREATE INDEX "Exception_tenantId_status_ownerRole_idx" ON "Exception"("tenantId", "status", "ownerRole");

-- CreateIndex
CREATE INDEX "Approval_tenantId_status_approverRole_idx" ON "Approval"("tenantId", "status", "approverRole");

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_readAt_idx" ON "Notification"("tenantId", "userId", "readAt");

-- CreateIndex
CREATE INDEX "EvidenceDocument_tenantId_subjectType_subjectId_idx" ON "EvidenceDocument"("tenantId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "EvidenceDocument_tenantId_sha256_idx" ON "EvidenceDocument"("tenantId", "sha256");

-- CreateIndex
CREATE INDEX "BusinessEvent_tenantId_type_status_idx" ON "BusinessEvent"("tenantId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEvent_tenantId_idempotencyKey_key" ON "BusinessEvent"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "IntegrationJob_tenantId_status_idx" ON "IntegrationJob"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationJob_tenantId_idempotencyKey_key" ON "IntegrationJob"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_entityType_entityId_idx" ON "AuditEvent"("tenantId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRequest_tenantId_key_key" ON "IdempotencyRequest"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exception" ADD CONSTRAINT "Exception_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_exceptionId_fkey" FOREIGN KEY ("exceptionId") REFERENCES "Exception"("id") ON DELETE SET NULL ON UPDATE CASCADE;
