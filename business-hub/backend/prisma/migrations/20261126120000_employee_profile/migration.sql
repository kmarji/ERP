ALTER TABLE "Employee" ADD COLUMN "gender" TEXT,
ADD COLUMN "maritalStatus" TEXT,
ADD COLUMN "workType" TEXT,
ADD COLUMN "department" TEXT,
ADD COLUMN "section" TEXT,
ADD COLUMN "workLocation" TEXT,
ADD COLUMN "probationMonths" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "photoKey" TEXT,
ADD COLUMN "photoType" TEXT;

UPDATE "Employee" e SET "probationMonths" = c."probationMonths"
FROM "EmploymentContract" c WHERE c."employeeId" = e.id AND c.version = 1;
