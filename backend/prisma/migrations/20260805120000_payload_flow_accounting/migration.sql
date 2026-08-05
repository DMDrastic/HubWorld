-- Attribute every signing payload to the flow that spent it.
--
-- The Xaman quota counts payloads CREATED and none of it can be reclaimed, so
-- it is consumed by users doing things rather than by tickets existing. Until
-- now every creation looked identical once made, which left the single most
-- valuable measurement in the system unanswerable: how many payloads does one
-- attendee cost, end to end.
--
-- BACKFILL, and why each value is the honest one:
--
--   flow    -> stays NULL. These rows genuinely have no recorded flow, and
--              inventing one would put fiction into the very number this exists
--              to measure. NULL reads as "before instrumentation" in the report.
--   network -> TESTNET. Factually what they are; XRPL_NETWORK has only ever
--              been 'testnet'.
--   signer  -> 'unknown', NOT 'xaman'. A dev database holds stub payloads that
--              cost no quota at all, and labelling those as real spend would
--              overstate consumption in exactly the place the number matters.
--              We cannot tell which is which after the fact, so we say so.
--
-- The DEFAULTs exist only for the length of this migration, so the columns can
-- be NOT NULL on a table that already holds rows, and are dropped immediately —
-- a surviving default would let a forgotten field silently label a mainnet
-- payload as testnet, or a stub as real spend.

-- CreateEnum
CREATE TYPE "PayloadFlow" AS ENUM (
  'SIGNIN',
  'DOOR_CHECKIN',
  'MINT',
  'GIFT_OFFER',
  'GIFT_ACCEPT',
  'GIFT_CANCEL',
  'LISTING_CREATE',
  'LISTING_BUY',
  'LISTING_CANCEL',
  'AUCTION_OPEN',
  'AUCTION_BID'
);

-- AlterTable
ALTER TABLE "XamanPayload" ADD COLUMN "flow"    "PayloadFlow";
ALTER TABLE "XamanPayload" ADD COLUMN "userId"  TEXT;
ALTER TABLE "XamanPayload" ADD COLUMN "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET';
ALTER TABLE "XamanPayload" ADD COLUMN "signer"  TEXT          NOT NULL DEFAULT 'unknown';

ALTER TABLE "XamanPayload" ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "XamanPayload" ALTER COLUMN "signer"  DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "XamanPayload"
  ADD CONSTRAINT "XamanPayload_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "XamanPayload_signer_network_createdAt_idx" ON "XamanPayload"("signer", "network", "createdAt");
CREATE INDEX "XamanPayload_userId_idx" ON "XamanPayload"("userId");
