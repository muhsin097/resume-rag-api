-- AlterTable
ALTER TABLE "users" ADD COLUMN     "portfolio_slug" TEXT,
ADD COLUMN     "portfolio_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "portfolio_leads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "visitor_email" TEXT NOT NULL,
    "visitor_name" TEXT,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolio_leads_user_id_idx" ON "portfolio_leads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_portfolio_slug_key" ON "users"("portfolio_slug");

-- AddForeignKey
ALTER TABLE "portfolio_leads" ADD CONSTRAINT "portfolio_leads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
