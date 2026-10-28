-- AlterTable
ALTER TABLE "resume_generations" ADD COLUMN     "extra_skill_titles" TEXT[] DEFAULT ARRAY[]::TEXT[];
