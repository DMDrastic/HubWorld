-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ORGANIZER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "OrganizerApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerApplication_userId_key" ON "OrganizerApplication"("userId");

-- CreateIndex
CREATE INDEX "OrganizerApplication_status_createdAt_idx" ON "OrganizerApplication"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizerApplication" ADD CONSTRAINT "OrganizerApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerApplication" ADD CONSTRAINT "OrganizerApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: anyone already organizing an event was, in practice, an organizer.
-- Without this the role change would silently revoke access from accounts that
-- have live events and minted tickets.
UPDATE "User" SET "role" = 'ORGANIZER'
 WHERE "id" IN (SELECT DISTINCT "organizerId" FROM "Event");
