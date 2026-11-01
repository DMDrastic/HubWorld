-- CreateTable
CREATE TABLE "FaucetGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaucetGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FaucetGrant_userId_createdAt_idx" ON "FaucetGrant"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "FaucetGrant" ADD CONSTRAINT "FaucetGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

