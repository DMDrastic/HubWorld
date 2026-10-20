-- CreateEnum
CREATE TYPE "DoorMode" AS ENUM ('SIGNATURE', 'QR');

-- CreateEnum
CREATE TYPE "RedemptionMethod" AS ENUM ('SIGNATURE', 'QR');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "doorMode" "DoorMode" NOT NULL DEFAULT 'SIGNATURE';

-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "method" "RedemptionMethod" NOT NULL DEFAULT 'SIGNATURE';
