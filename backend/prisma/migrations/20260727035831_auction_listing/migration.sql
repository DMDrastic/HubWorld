-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "auctionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Listing_auctionId_key" ON "Listing"("auctionId");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

