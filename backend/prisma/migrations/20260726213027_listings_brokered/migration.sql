-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "brokerTxHash" TEXT,
ADD COLUMN     "buyOfferIndex" TEXT,
ADD COLUMN     "buyPayloadUuid" TEXT,
ADD COLUMN     "buyTxHash" TEXT,
ADD COLUMN     "buyerAddress" TEXT,
ADD COLUMN     "buyerId" TEXT,
ADD COLUMN     "cancelPayloadUuid" TEXT,
ADD COLUMN     "cancelTxHash" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "listPayloadUuid" TEXT NOT NULL,
ADD COLUMN     "listTxHash" TEXT,
ADD COLUMN     "listedAt" TIMESTAMP(3),
ADD COLUMN     "platformFeeDrops" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "sellerAddress" TEXT NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PENDING_OFFER';

-- CreateIndex
CREATE UNIQUE INDEX "Listing_listPayloadUuid_key" ON "Listing"("listPayloadUuid");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_buyPayloadUuid_key" ON "Listing"("buyPayloadUuid");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_cancelPayloadUuid_key" ON "Listing"("cancelPayloadUuid");

-- CreateIndex
CREATE INDEX "Listing_ticketId_createdAt_idx" ON "Listing"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "Listing_sellerId_status_idx" ON "Listing"("sellerId", "status");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
