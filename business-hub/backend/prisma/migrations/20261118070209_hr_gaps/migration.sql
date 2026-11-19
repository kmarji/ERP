-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "geofenceM" INTEGER,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "ShiftSchedule" ADD COLUMN     "noShowAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OpenShift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "scheduleId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpenShiftRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "openShiftId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenShiftRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenShift_tenantId_branchId_status_idx" ON "OpenShift"("tenantId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpenShiftRequest_openShiftId_employeeId_key" ON "OpenShiftRequest"("openShiftId", "employeeId");

-- AddForeignKey
ALTER TABLE "OpenShiftRequest" ADD CONSTRAINT "OpenShiftRequest_openShiftId_fkey" FOREIGN KEY ("openShiftId") REFERENCES "OpenShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
