import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { VoyageClient } from './voyage.client.js';

export interface SimilarExperienceItem {
  id: string;
  distance: number;
}

export interface SimilarCandidate {
  userId: string;
  itemId: string;
  title: string;
  organization: string | null;
  distance: number;
}

// Prisma's query builder has no concept of pgvector's operators, so every
// read/write of the `embedding` column goes through raw SQL here -- this is
// the one place in the app that talks to pgvector directly.
@Injectable()
export class VectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly voyageClient: VoyageClient,
    private readonly configService: ConfigService,
  ) {}

  async embedExperienceItem(experienceItemId: string, content: string) {
    await this.embedExperienceItems([{ id: experienceItemId, content }]);
  }

  // Embeds a batch of items with ONE Voyage request, regardless of how many
  // there are. This is the difference between "import a 15-item resume" or
  // "bulk-add 10 skills" costing 1 request vs. 15 -- the latter blows
  // straight through Voyage's free-tier 3-requests/minute cap.
  async embedExperienceItems(
    items: { id: string; content: string }[],
  ): Promise<void> {
    if (items.length === 0) return;

    const embeddings = await this.voyageClient.embedMany(
      items.map((item) => item.content),
    );
    const model =
      this.configService.get<string>('VOYAGE_EMBEDDING_MODEL') ??
      'voyage-3-lite';

    for (let i = 0; i < items.length; i++) {
      const vectorLiteral = toVectorLiteral(embeddings[i]);
      const id = randomUUID();
      await this.prisma.$executeRaw`
        INSERT INTO "experience_embeddings" ("id", "experience_item_id", "embedding", "model", "created_at")
        VALUES (${id}, ${items[i].id}, ${vectorLiteral}::vector, ${model}, now())
        ON CONFLICT ("experience_item_id")
        DO UPDATE SET "embedding" = EXCLUDED."embedding", "model" = EXCLUDED."model", "created_at" = now()
      `;
    }
  }

  // Cosine distance (`<=>`) scoped to one user's own experience items --
  // this is the retrieval half of RAG: convert the query text (a job
  // description) to a vector, then find which of the user's own chunks are
  // semantically closest to it.
  // `types`, when given, scopes retrieval to those ExperienceTypes --
  // used to rank only EXPERIENCE/PROJECT items by JD relevance, while
  // catalog facts (skills, languages, education, etc.) are fetched in
  // full elsewhere rather than competing for the same top-K slots.
  async findSimilarExperienceItems(
    userId: string,
    queryText: string,
    limit = 8,
    types?: string[],
  ): Promise<SimilarExperienceItem[]> {
    const embedding = await this.voyageClient.embed(queryText);
    const vectorLiteral = toVectorLiteral(embedding);

    if (types && types.length > 0) {
      return this.prisma.$queryRaw<SimilarExperienceItem[]>`
        SELECT i."id" AS id, (e."embedding" <=> ${vectorLiteral}::vector) AS distance
        FROM "experience_embeddings" e
        JOIN "experience_items" i ON i."id" = e."experience_item_id"
        WHERE i."user_id" = ${userId} AND i."type"::text = ANY(${types})
        ORDER BY distance ASC
        LIMIT ${limit}
      `;
    }

    return this.prisma.$queryRaw<SimilarExperienceItem[]>`
      SELECT i."id" AS id, (e."embedding" <=> ${vectorLiteral}::vector) AS distance
      FROM "experience_embeddings" e
      JOIN "experience_items" i ON i."id" = e."experience_item_id"
      WHERE i."user_id" = ${userId}
      ORDER BY distance ASC
      LIMIT ${limit}
    `;
  }

  // Same cosine-distance retrieval as above, but aggregated across *all*
  // opted-in candidates instead of scoped to one user -- this is the
  // recruiter-side half of the same RAG infrastructure. DISTINCT ON picks
  // each candidate's single closest-matching item in one pass (both the
  // ranking signal AND a snippet to show), so the whole search costs
  // exactly one Voyage embed call no matter how many candidates match --
  // looking up each candidate's best item separately would re-embed the
  // query once per result and blow through the free-tier rate limit.
  async findSimilarCandidates(
    queryText: string,
    limit = 10,
  ): Promise<SimilarCandidate[]> {
    const embedding = await this.voyageClient.embed(queryText);
    const vectorLiteral = toVectorLiteral(embedding);

    return this.prisma.$queryRaw<SimilarCandidate[]>`
      SELECT "userId", "itemId", "title", "organization", "distance" FROM (
        SELECT DISTINCT ON (i."user_id")
          i."user_id" AS "userId",
          i."id" AS "itemId",
          i."title" AS "title",
          i."organization" AS "organization",
          (e."embedding" <=> ${vectorLiteral}::vector) AS "distance"
        FROM "experience_embeddings" e
        JOIN "experience_items" i ON i."id" = e."experience_item_id"
        JOIN "users" u ON u."id" = i."user_id"
        WHERE u."job_search_enabled" = true
        ORDER BY i."user_id", "distance" ASC
      ) ranked
      ORDER BY "distance" ASC
      LIMIT ${limit}
    `;
  }
}

// pgvector accepts vectors over the wire as a string like "[0.1,0.2,...]".
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
