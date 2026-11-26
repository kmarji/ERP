ALTER TABLE "Employee" ADD COLUMN "nationality" TEXT,
ADD COLUMN "needsWorkPermit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "workPermitNumber" TEXT,
ADD COLUMN "workPermitExpiry" DATE,
ADD COLUMN "workPermitAlertStage" INTEGER;
