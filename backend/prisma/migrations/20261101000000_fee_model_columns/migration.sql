-- CreateEnum
CREATE TYPE "PriceCurrency" AS ENUM ('USD', 'XRP', 'RLUSD');

-- CreateEnum
CREATE TYPE "FeeRegion" AS ENUM ('CARIBBEAN', 'CANADA');

-- CreateEnum
CREATE TYPE "ListingFeeModel" AS ENUM ('BUYER_PAYS_V1', 'SELLER_PAYS_V2');

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "feeBps" INTEGER;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "feeRegion" "FeeRegion" NOT NULL DEFAULT 'CARIBBEAN',
ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'America/St_Lucia';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "feeBps" INTEGER,
ADD COLUMN     "feeModel" "ListingFeeModel" NOT NULL DEFAULT 'BUYER_PAYS_V1';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "originalCostCurrency" "PriceCurrency",
ADD COLUMN     "originalCostMinor" BIGINT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "foundingGrantedAt" TIMESTAMP(3),
ADD COLUMN     "foundingOrganizer" BOOLEAN NOT NULL DEFAULT false;

