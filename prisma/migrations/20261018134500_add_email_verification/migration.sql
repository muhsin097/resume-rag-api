-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verification_code_hash" TEXT,
ADD COLUMN     "email_verification_expires_at" TIMESTAMP(3),
ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- Backfill: this requirement is new. Retroactively locking out every
-- existing account until they complete a verification flow they never
-- signed up expecting would be a self-inflicted outage, not a security
-- improvement -- so existing rows are considered already verified.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
