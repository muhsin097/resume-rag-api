-- CreateEnum
CREATE TYPE "CreditPack" AS ENUM ('STARTER', 'JOB_SEARCH', 'INTENSIVE');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "credits_balance" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "credits_expire_at" TIMESTAMP(3),
ADD COLUMN     "resume_imports_used" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "credit_purchases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pack" "CreditPack" NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "razorpay_payment_id" TEXT,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "credit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_purchases_razorpay_order_id_key" ON "credit_purchases"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_purchases_razorpay_payment_id_key" ON "credit_purchases"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "credit_purchases_user_id_idx" ON "credit_purchases"("user_id");

-- AddForeignKey
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the new free tier is 2 lifetime generations (down from the
-- old FREE_GENERATIONS_LIMIT=5), applied retroactively against actual
-- historical usage -- someone who's already generated 2+ times under the
-- old limit now has 0 credits left, not a bonus 2. PREMIUM accounts are
-- unaffected either way since that plan bypasses credits_balance entirely
-- (see the gating logic in ResumeGenerationsService), but backfilled the
-- same formula for consistency rather than leaving the column meaningless
-- for them.
UPDATE "users"
SET "credits_balance" = GREATEST(0, 2 - "free_generations_used")
WHERE "deleted_at" IS NULL;
