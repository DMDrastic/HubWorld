-- AlterTable
ALTER TABLE "XamanPayload" ADD COLUMN     "expectedAccount" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "submitError" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "unsignedTx" JSONB;

