-- AlterTable
ALTER TABLE "resume_generations" ADD COLUMN     "keyword_coverage" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows from their already-stored matched/missing arrays,
-- same formula the application now uses going forward, so History doesn't
-- show a misleading 0 for every past generation. Falls back to the
-- existing match_score (now fitScore) only for the rare row with no
-- keywords extracted at all.
UPDATE "resume_generations"
SET "keyword_coverage" = CASE
  WHEN COALESCE(array_length("matched_keywords", 1), 0) + COALESCE(array_length("missing_keywords", 1), 0) = 0
    THEN "match_score"
  ELSE ROUND(
    100.0 * COALESCE(array_length("matched_keywords", 1), 0)
    / (COALESCE(array_length("matched_keywords", 1), 0) + COALESCE(array_length("missing_keywords", 1), 0))
  )
END;
