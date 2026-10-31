-- CreateEnum
CREATE TYPE "SignerKind" AS ENUM ('XAMAN', 'PRIVY');

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xrplAddress" TEXT NOT NULL,
    "signerKind" "SignerKind" NOT NULL,
    "providerUserId" TEXT,
    "publicKey" TEXT,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_xrplAddress_key" ON "Wallet"("xrplAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_signerKind_providerUserId_key" ON "Wallet"("signerKind", "providerUserId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing user signed in with Xaman, so each gets one XAMAN wallet carrying
-- the address they already have. This is DATA, not schema, which is why it is written by hand
-- (the DDL above is Prisma's own diff). `activatedAt` stays NULL: a sign-in proves control of
-- an address, not that the account is funded, and a guess recorded as a fact would be wrong.
-- Idempotent: a re-run, or a user who already has a Wallet, inserts nothing.
INSERT INTO "Wallet" ("id", "userId", "xrplAddress", "signerKind")
SELECT gen_random_uuid()::text, u."id", u."xrplAddress", 'XAMAN'
FROM "User" u
ON CONFLICT DO NOTHING;
