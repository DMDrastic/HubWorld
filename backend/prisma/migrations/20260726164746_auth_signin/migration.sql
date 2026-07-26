-- CreateEnum
CREATE TYPE "SignInStatus" AS ENUM ('PENDING', 'SIGNED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "SignInRequest" (
    "id" TEXT NOT NULL,
    "payloadUuid" TEXT NOT NULL,
    "status" "SignInStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedAddress" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignInRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignInRequest_payloadUuid_key" ON "SignInRequest"("payloadUuid");

-- CreateIndex
CREATE INDEX "SignInRequest_status_expiresAt_idx" ON "SignInRequest"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "SignInRequest" ADD CONSTRAINT "SignInRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
