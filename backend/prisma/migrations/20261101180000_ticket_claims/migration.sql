-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "TransferKind" ADD VALUE 'CLAIM';

-- CreateTable
CREATE TABLE "TicketClaim" (
    "id" TEXT NOT NULL,
    "network" "XrplNetwork" NOT NULL,
    "ticketId" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "holderAddress" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "offerIndex" TEXT,
    "offerTxHash" TEXT,
    "acceptTxHash" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketClaim_ticketId_key" ON "TicketClaim"("ticketId");

-- CreateIndex
CREATE INDEX "TicketClaim_status_expiresAt_idx" ON "TicketClaim"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "TicketClaim" ADD CONSTRAINT "TicketClaim_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketClaim" ADD CONSTRAINT "TicketClaim_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

