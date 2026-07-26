-- CreateEnum
CREATE TYPE "GiftStatus" AS ENUM ('PENDING_OFFER', 'OFFERED', 'ACCEPTING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "Gift" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "status" "GiftStatus" NOT NULL DEFAULT 'PENDING_OFFER',
    "offerPayloadUuid" TEXT NOT NULL,
    "offerTxHash" TEXT,
    "offerIndex" TEXT,
    "acceptPayloadUuid" TEXT,
    "acceptTxHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "offeredAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Gift_offerPayloadUuid_key" ON "Gift"("offerPayloadUuid");

-- CreateIndex
CREATE UNIQUE INDEX "Gift_acceptPayloadUuid_key" ON "Gift"("acceptPayloadUuid");

-- CreateIndex
CREATE INDEX "Gift_toId_status_idx" ON "Gift"("toId", "status");

-- CreateIndex
CREATE INDEX "Gift_fromId_status_idx" ON "Gift"("fromId", "status");

-- CreateIndex
CREATE INDEX "Gift_ticketId_createdAt_idx" ON "Gift"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "Gift" ADD CONSTRAINT "Gift_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gift" ADD CONSTRAINT "Gift_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gift" ADD CONSTRAINT "Gift_toId_fkey" FOREIGN KEY ("toId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
