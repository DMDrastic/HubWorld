-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'REDEEMED', 'REJECTED', 'EXPIRED', 'NO_TICKET', 'ALREADY_USED');

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "payloadUuid" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "eventId" TEXT NOT NULL,
    "ticketId" TEXT,
    "resolvedAddress" TEXT,
    "holderId" TEXT,
    "staffId" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_payloadUuid_key" ON "Redemption"("payloadUuid");

-- CreateIndex
CREATE INDEX "Redemption_eventId_status_idx" ON "Redemption"("eventId", "status");

-- CreateIndex
CREATE INDEX "Redemption_ticketId_idx" ON "Redemption"("ticketId");

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

