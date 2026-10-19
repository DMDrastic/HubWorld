-- CreateEnum
CREATE TYPE "DelegationKind" AS ENUM ('GRANT', 'REVOKE');

-- CreateEnum
CREATE TYPE "DelegationStatus" AS ENUM ('PENDING', 'SIGNED', 'ACTIVE', 'REVOKED', 'REJECTED', 'EXPIRED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayloadFlow" ADD VALUE 'DELEGATE_GRANT';
ALTER TYPE "PayloadFlow" ADD VALUE 'DELEGATE_REVOKE';

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL,
    "network" "XrplNetwork" NOT NULL,
    "organizerId" TEXT NOT NULL,
    "organizerAddress" TEXT NOT NULL,
    "delegateAddress" TEXT NOT NULL,
    "kind" "DelegationKind" NOT NULL,
    "status" "DelegationStatus" NOT NULL DEFAULT 'PENDING',
    "payloadUuid" TEXT NOT NULL,
    "txHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Delegation_payloadUuid_key" ON "Delegation"("payloadUuid");

-- CreateIndex
CREATE INDEX "Delegation_organizerId_createdAt_idx" ON "Delegation"("organizerId", "createdAt");

-- CreateIndex
CREATE INDEX "Delegation_status_expiresAt_idx" ON "Delegation"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

