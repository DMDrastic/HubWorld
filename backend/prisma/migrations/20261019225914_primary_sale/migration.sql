-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "primaryPriceDrops" BIGINT;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "reservedForId" TEXT;

-- CreateIndex
CREATE INDEX "Listing_reservedForId_status_idx" ON "Listing"("reservedForId", "status");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_reservedForId_fkey" FOREIGN KEY ("reservedForId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

