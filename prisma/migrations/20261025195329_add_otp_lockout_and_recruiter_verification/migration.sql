-- AlterTable
ALTER TABLE "recruiters" ADD COLUMN     "email_verification_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "email_verification_code_hash" TEXT,
ADD COLUMN     "email_verification_expires_at" TIMESTAMP(3),
ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verification_attempts" INTEGER NOT NULL DEFAULT 0;

-- Grandfather every existing recruiter as verified -- login() is about to
-- start blocking on email_verified_at, and none of these rows ever went
-- through an OTP step (that flow didn't exist until this migration).
-- Without this, every current recruiter is locked out the moment this
-- ships.
UPDATE "recruiters" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
