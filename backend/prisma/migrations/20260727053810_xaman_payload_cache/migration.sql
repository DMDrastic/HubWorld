-- CreateTable
CREATE TABLE "XamanPayload" (
    "uuid" TEXT NOT NULL,
    "signed" BOOLEAN NOT NULL DEFAULT false,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "account" TEXT,
    "txid" TEXT,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'poll',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XamanPayload_pkey" PRIMARY KEY ("uuid")
);

-- CreateIndex
CREATE INDEX "XamanPayload_terminal_fetchedAt_idx" ON "XamanPayload"("terminal", "fetchedAt");

