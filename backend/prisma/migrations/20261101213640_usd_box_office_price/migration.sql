-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "primaryPriceCurrency" "PriceCurrency",
ADD COLUMN     "primaryPriceMinor" BIGINT;

-- CreateTable
CREATE TABLE "PriceConversion" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "fromCurrency" "PriceCurrency" NOT NULL,
    "fromMinor" BIGINT NOT NULL,
    "toCurrency" "PriceCurrency" NOT NULL,
    "toMinor" BIGINT NOT NULL,
    "microUsdPerXrp" BIGINT NOT NULL,
    "rateAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceConversion_subject_subjectId_idx" ON "PriceConversion"("subject", "subjectId");

