-- AlterEnum
ALTER TYPE "GiftStatus" ADD VALUE 'CANCELLING';

-- AlterTable
ALTER TABLE "Gift" ADD COLUMN     "cancelPayloadUuid" TEXT,
ADD COLUMN     "cancelTxHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Gift_cancelPayloadUuid_key" ON "Gift"("cancelPayloadUuid");

