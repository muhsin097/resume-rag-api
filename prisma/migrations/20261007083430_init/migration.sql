-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "ExperienceType" AS ENUM ('EXPERIENCE', 'EDUCATION', 'CERTIFICATION', 'PROJECT', 'ACHIEVEMENT', 'SKILL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "job_search_enabled" BOOLEAN NOT NULL DEFAULT false,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "free_generations_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experience_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "ExperienceType" NOT NULL,
    "title" TEXT NOT NULL,
    "organization" TEXT,
    "description" TEXT,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "experience_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experience_embeddings" (
    "id" TEXT NOT NULL,
    "experience_item_id" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experience_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_generations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "job_description" TEXT NOT NULL,
    "retrieved_item_ids" JSONB NOT NULL,
    "generated_content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "experience_items_user_id_idx" ON "experience_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "experience_embeddings_experience_item_id_key" ON "experience_embeddings"("experience_item_id");

-- CreateIndex
CREATE INDEX "resume_generations_user_id_idx" ON "resume_generations"("user_id");

-- AddForeignKey
ALTER TABLE "experience_items" ADD CONSTRAINT "experience_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experience_embeddings" ADD CONSTRAINT "experience_embeddings_experience_item_id_fkey" FOREIGN KEY ("experience_item_id") REFERENCES "experience_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_generations" ADD CONSTRAINT "resume_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
