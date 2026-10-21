-- AlterTable
ALTER TABLE "experience_items" ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows with a null end_date were always rendered as "Present"
-- under the old (ambiguous) logic -- backfill is_current=true for those
-- so existing data keeps displaying exactly as it does today. Only rows
-- created after this migration get the more precise "ended, date
-- unknown" distinction (via the updated extraction prompt / manual-entry
-- checkbox). Scoped to the date-range types; CERTIFICATION uses a single
-- date and never showed "Present" in the first place.
UPDATE "experience_items"
SET "is_current" = true
WHERE "end_date" IS NULL
  AND "type" IN ('EXPERIENCE', 'EDUCATION', 'PROJECT');
