-- CreateTable
CREATE TABLE "PriceReading" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL DEFAULT 'XRPUSD',
    "microUsd" BIGINT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceReading_pair_createdAt_idx" ON "PriceReading"("pair", "createdAt");

