-- CreateEnum
CREATE TYPE "MintStatus" AS ENUM ('PENDING', 'SIGNED', 'MINTED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "MintRequest" (
    "id" TEXT NOT NULL,
    "payloadUuid" TEXT NOT NULL,
    "status" "MintStatus" NOT NULL DEFAULT 'PENDING',
    "eventId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "seat" TEXT,
    "tier" TEXT,
    "txHash" TEXT,
    "nfTokenId" TEXT,
    "ticketId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MintRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MintRequest_payloadUuid_key" ON "MintRequest"("payloadUuid");

-- CreateIndex
CREATE UNIQUE INDEX "MintRequest_ticketId_key" ON "MintRequest"("ticketId");

-- CreateIndex
CREATE INDEX "MintRequest_status_expiresAt_idx" ON "MintRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "MintRequest_eventId_createdAt_idx" ON "MintRequest"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "MintRequest" ADD CONSTRAINT "MintRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MintRequest" ADD CONSTRAINT "MintRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
