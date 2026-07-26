-- Enum values must be committed before the table migration can default to
-- one of them (Postgres: "unsafe use of new value").
ALTER TYPE "ListingStatus" ADD VALUE 'PENDING_OFFER';
ALTER TYPE "ListingStatus" ADD VALUE 'BUYER_PENDING';
ALTER TYPE "ListingStatus" ADD VALUE 'SETTLING';
ALTER TYPE "ListingStatus" ADD VALUE 'CANCELLING';
ALTER TYPE "ListingStatus" ADD VALUE 'FAILED';
