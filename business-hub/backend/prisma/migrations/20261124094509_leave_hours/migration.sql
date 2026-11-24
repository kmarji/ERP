-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "endTime" TEXT,
ADD COLUMN     "hours" DECIMAL(5,2),
ADD COLUMN     "startTime" TEXT;
