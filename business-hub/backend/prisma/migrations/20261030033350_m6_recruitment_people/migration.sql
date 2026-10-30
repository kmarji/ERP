-- CreateEnum
CREATE TYPE "VacancyStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'OPEN', 'FILLED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('RECEIVED', 'INCOMPLETE', 'SCREENED_OUT', 'SCREENED', 'INTERVIEW_INVITED', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'UNDER_REVIEW', 'ADVANCED', 'OFFER_PENDING', 'ONBOARDING', 'HIRED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('INVITED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvalRecommendation" AS ENUM ('ADVANCE', 'REVIEW', 'DECLINE');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('REQUIRED', 'RECEIVED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "SscKind" AS ENUM ('REGISTRATION', 'CHANGE', 'TERMINATION');

-- CreateEnum
CREATE TYPE "SscStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'DONE');

-- CreateTable
CREATE TABLE "JobPosition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleAr" TEXT,
    "payBandMin" DECIMAL(18,3) NOT NULL,
    "payBandMax" DECIMAL(18,3) NOT NULL,
    "requiredSkills" JSONB NOT NULL DEFAULT '[]',
    "eligibilityCriteria" JSONB NOT NULL DEFAULT '[]',
    "interviewTemplateId" TEXT,
    "requiredDocuments" JSONB NOT NULL DEFAULT '["NATIONAL_ID","BANK_DETAILS"]',
    "trainingModules" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeadcountBudget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "approved" INTEGER NOT NULL,

    CONSTRAINT "HeadcountBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vacancy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL,
    "filled" INTEGER NOT NULL DEFAULT 0,
    "payMin" DECIMAL(18,3) NOT NULL,
    "payMax" DECIMAL(18,3) NOT NULL,
    "requiredSkills" JSONB NOT NULL DEFAULT '[]',
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "status" "VacancyStatus" NOT NULL DEFAULT 'DRAFT',
    "publicCode" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "notes" TEXT,
    "requestedBy" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vacancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "questions" JSONB NOT NULL,
    "rubric" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "dataConsentAt" TIMESTAMP(3) NOT NULL,
    "privacyNoticeVersion" TEXT NOT NULL,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'RECEIVED',
    "intake" JSONB NOT NULL DEFAULT '{}',
    "missing" JSONB NOT NULL DEFAULT '[]',
    "eligibility" JSONB NOT NULL DEFAULT '[]',
    "trackingToken" TEXT NOT NULL,
    "rejectionReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "humanInterviewRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateSnapshot" JSONB NOT NULL,
    "language" TEXT NOT NULL,
    "status" "InterviewStatus" NOT NULL DEFAULT 'INVITED',
    "accessToken" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consent" JSONB,
    "consentAt" TIMESTAMP(3),
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "recordingDocId" TEXT,
    "currentQuestion" INTEGER NOT NULL DEFAULT 0,
    "followUpsUsed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "overall" DECIMAL(5,2) NOT NULL,
    "recommendation" "EvalRecommendation" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "rubricVersion" INTEGER NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewDecision" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
    "originalDecidedBy" TEXT,
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "contractType" TEXT NOT NULL DEFAULT 'OPEN',
    "endDate" DATE,
    "salaryBasic" DECIMAL(18,3) NOT NULL,
    "allowances" JSONB NOT NULL DEFAULT '[]',
    "weeklyHours" DECIMAL(5,2) NOT NULL DEFAULT 48,
    "probationMonths" INTEGER NOT NULL DEFAULT 3,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "contractText" JSONB,
    "contractDocId" TEXT,
    "candidateSignedAt" TIMESTAMP(3),
    "candidateSignature" TEXT,
    "countersignedBy" TEXT,
    "countersignedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "DocStatus" NOT NULL DEFAULT 'REQUIRED',
    "evidenceDocumentId" TEXT,
    "verifiedBy" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "userId" TEXT,
    "candidateId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ONBOARDING',
    "hireDate" DATE NOT NULL,
    "terminationDate" DATE,
    "positionId" TEXT NOT NULL,
    "sensitive" TEXT,
    "attendanceProfile" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,

    CONSTRAINT "EmployeeAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentContract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "salaryBasic" DECIMAL(18,3) NOT NULL,
    "allowances" JSONB NOT NULL DEFAULT '[]',
    "weeklyHours" DECIMAL(5,2) NOT NULL,
    "probationMonths" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "documentId" TEXT,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmploymentContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SscAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "SscKind" NOT NULL,
    "status" "SscStatus" NOT NULL DEFAULT 'PREPARED',
    "payload" JSONB NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "SscAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "dueDate" DATE,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInvite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "UserInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobPosition_tenantId_title_key" ON "JobPosition"("tenantId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "HeadcountBudget_branchId_positionId_key" ON "HeadcountBudget"("branchId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "Vacancy_publicCode_key" ON "Vacancy"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "Vacancy_tenantId_number_key" ON "Vacancy"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_tenantId_phone_key" ON "Candidate"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Application_trackingToken_key" ON "Application"("trackingToken");

-- CreateIndex
CREATE INDEX "Application_tenantId_status_idx" ON "Application"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Application_vacancyId_candidateId_key" ON "Application"("vacancyId", "candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "Interview_applicationId_key" ON "Interview"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Interview_accessToken_key" ON "Interview"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_interviewId_key" ON "Evaluation"("interviewId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_applicationId_key" ON "Offer"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_tenantId_number_key" ON "Offer"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDocument_applicationId_type_key" ON "ApplicationDocument"("applicationId", "type");

-- CreateIndex
CREATE INDEX "Employee_tenantId_status_idx" ON "Employee"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_number_key" ON "Employee"("tenantId", "number");

-- CreateIndex
CREATE INDEX "EmployeeAssignment_tenantId_branchId_idx" ON "EmployeeAssignment"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "EmploymentContract_employeeId_version_key" ON "EmploymentContract"("employeeId", "version");

-- CreateIndex
CREATE INDEX "SscAction_tenantId_status_idx" ON "SscAction"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UserInvite_tokenHash_key" ON "UserInvite"("tokenHash");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeAssignment" ADD CONSTRAINT "EmployeeAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmploymentContract" ADD CONSTRAINT "EmploymentContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
