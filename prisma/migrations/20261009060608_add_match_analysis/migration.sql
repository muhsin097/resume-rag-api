-- AlterTable
ALTER TABLE "resume_generations" ADD COLUMN     "match_score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "matched_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "missing_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
