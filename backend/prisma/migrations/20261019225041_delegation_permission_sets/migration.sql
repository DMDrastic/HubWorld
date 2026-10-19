-- AlterTable
ALTER TABLE "Delegation" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

