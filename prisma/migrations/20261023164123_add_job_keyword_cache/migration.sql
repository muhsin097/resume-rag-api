-- CreateTable
CREATE TABLE "job_keyword_cache" (
    "id" TEXT NOT NULL,
    "job_description_hash" TEXT NOT NULL,
    "keywords" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_keyword_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_keyword_cache_job_description_hash_key" ON "job_keyword_cache"("job_description_hash");
