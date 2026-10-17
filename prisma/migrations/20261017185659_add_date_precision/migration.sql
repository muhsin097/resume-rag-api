-- CreateEnum
CREATE TYPE "DatePrecision" AS ENUM ('YEAR', 'MONTH', 'DAY');

-- AlterTable
ALTER TABLE "experience_items" ADD COLUMN     "end_date_precision" "DatePrecision",
ADD COLUMN     "start_date_precision" "DatePrecision";
