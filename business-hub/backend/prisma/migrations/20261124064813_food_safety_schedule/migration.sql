-- AlterTable
ALTER TABLE "FoodSafetyPoint" ADD COLUMN     "readingTimes" TEXT[] DEFAULT ARRAY[]::TEXT[];
