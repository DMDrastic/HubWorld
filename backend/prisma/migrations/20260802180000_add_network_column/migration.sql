-- Records which XRP Ledger each row's on-ledger identifiers belong to.
--
-- Backfilled to TESTNET because that is what every existing row factually is:
-- XRPL_NETWORK has only ever been 'testnet'.
--
-- The DEFAULT exists only for the duration of this migration. It is added so
-- the column can be NOT NULL on tables that already hold rows, then DROPped
-- immediately -- a surviving default would let a forgotten field silently
-- label a mainnet row as testnet, which is the exact failure this column is
-- meant to make impossible.

-- CreateEnum
CREATE TYPE "XrplNetwork" AS ENUM ('TESTNET', 'DEVNET', 'MAINNET');

-- AlterTable: add, backfill via DEFAULT, then remove the default.
ALTER TABLE "Auction"     ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Bid"         ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Event"       ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Gift"        ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Listing"     ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "MintRequest" ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Redemption"  ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Ticket"      ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "Transfer"    ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';

ALTER TABLE "Auction"     ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Bid"         ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Event"       ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Gift"        ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Listing"     ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "MintRequest" ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Redemption"  ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Ticket"      ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "Transfer"    ALTER COLUMN "network" DROP DEFAULT;

-- An NFTokenID and a tx hash are unique only WITHIN a network: both derive from
-- the issuer's AccountID and sequence, neither of which is network-specific, so
-- the same account acting identically on two networks collides.
-- DropIndex
DROP INDEX "Ticket_nfTokenId_key";
DROP INDEX "Transfer_txHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_network_nfTokenId_key" ON "Ticket"("network", "nfTokenId");
CREATE UNIQUE INDEX "Transfer_network_txHash_key" ON "Transfer"("network", "txHash");
CREATE INDEX "Event_network_status_idx" ON "Event"("network", "status");
CREATE INDEX "Ticket_network_status_idx" ON "Ticket"("network", "status");
