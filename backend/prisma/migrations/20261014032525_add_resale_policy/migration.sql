-- CreateEnum
CREATE TYPE "ResalePolicy" AS ENUM ('UNRESTRICTED', 'PERCENTAGE_CAP', 'FIXED_CAP', 'FACE_VALUE_ONLY', 'DISABLED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "resaleCapBps" INTEGER,
ADD COLUMN     "resaleCapDrops" BIGINT,
ADD COLUMN     "resalePolicy" "ResalePolicy" NOT NULL DEFAULT 'UNRESTRICTED';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "faceValueDrops" BIGINT;
