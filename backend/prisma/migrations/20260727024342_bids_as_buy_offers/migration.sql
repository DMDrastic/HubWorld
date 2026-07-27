-- AlterEnum
BEGIN;
CREATE TYPE "BidStatus_new" AS ENUM ('PENDING', 'COMMITTED', 'OUTBID', 'WON', 'LOST', 'CANCELLED', 'FAILED');
ALTER TABLE "public"."Bid" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Bid" ALTER COLUMN "status" TYPE "BidStatus_new" USING ("status"::text::"BidStatus_new");
ALTER TYPE "BidStatus" RENAME TO "BidStatus_old";
ALTER TYPE "BidStatus_new" RENAME TO "BidStatus";
DROP TYPE "public"."BidStatus_old";
ALTER TABLE "Bid" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "Bid" DROP COLUMN "escrowSeq",
DROP COLUMN "escrowTxHash",
ADD COLUMN     "bidPayloadUuid" TEXT,
ADD COLUMN     "bidderAddress" TEXT,
ADD COLUMN     "buyOfferIndex" TEXT,
ADD COLUMN     "buyTxHash" TEXT,
ADD COLUMN     "committedAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Bid_bidPayloadUuid_key" ON "Bid"("bidPayloadUuid");

-- CreateIndex
CREATE INDEX "Bid_auctionId_status_idx" ON "Bid"("auctionId", "status");

