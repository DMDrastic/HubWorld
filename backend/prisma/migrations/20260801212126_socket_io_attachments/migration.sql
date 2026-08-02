-- CreateTable
CREATE TABLE "socket_io_attachments" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" BYTEA,

    CONSTRAINT "socket_io_attachments_pkey" PRIMARY KEY ("id")
);
