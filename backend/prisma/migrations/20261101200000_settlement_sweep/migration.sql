-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "settleAlertedAt" TIMESTAMP(3),
ADD COLUMN     "settleClaimedUntil" TIMESTAMP(3),
ADD COLUMN     "settleNextAt" TIMESTAMP(3),
ADD COLUMN     "settleStrikes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settlingSince" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ListingBuyerNotice" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountDrops" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingBuyerNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingBuyerNotice_userId_createdAt_idx" ON "ListingBuyerNotice"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ListingBuyerNotice" ADD CONSTRAINT "ListingBuyerNotice_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingBuyerNotice" ADD CONSTRAINT "ListingBuyerNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

