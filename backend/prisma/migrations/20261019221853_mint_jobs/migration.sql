-- CreateEnum
CREATE TYPE "MintJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MintJob" (
    "id" TEXT NOT NULL,
    "network" "XrplNetwork" NOT NULL,
    "eventId" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "organizerAddress" TEXT NOT NULL,
    "delegateAddress" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "minted" INTEGER NOT NULL DEFAULT 0,
    "failedTxs" INTEGER NOT NULL DEFAULT 0,
    "status" "MintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "statusReason" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "pendingWave" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MintJob_status_nextAttemptAt_idx" ON "MintJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MintJob_eventId_createdAt_idx" ON "MintJob"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "MintJob" ADD CONSTRAINT "MintJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MintJob" ADD CONSTRAINT "MintJob_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

