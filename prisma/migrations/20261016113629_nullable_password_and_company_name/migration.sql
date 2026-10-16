-- AlterTable
ALTER TABLE "recruiters" ALTER COLUMN "password_hash" DROP NOT NULL,
ALTER COLUMN "company_name" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
