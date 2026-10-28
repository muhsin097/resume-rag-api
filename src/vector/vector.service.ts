import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { VoyageClient } from './voyage.client.js';

export interface PreparedEmbedding {
  vectorLiteral: string;
  model: string;
}

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

  // Computes an embedding WITHOUT writing anything -- deliberately
  // separate from persisting it. The old embedExperienceItem(s) created
  // the ExperienceItem row first and only called Voyage afterward: if
  // that call failed (rate limit, network blip, Voyage outage), the row
  // was already committed with no embedding at all, invisible to every
  // RAG-based feature (resume generation, recruiter search) with no
  // error surfaced anywhere -- and a retry would just hit
  // findDuplicate's ConflictException, since the "duplicate" was itself
  // the orphan, with no path to repair it. Callers now embed FIRST and
  // only create the row(s) if that succeeds, so a failure here leaves
  // nothing behind to orphan -- see ExperienceItemsService.create.
  async prepareEmbedding(content: string): Promise<PreparedEmbedding> {
    const embedding = await this.voyageClient.embed(content);
    return { vectorLiteral: toVectorLiteral(embedding), model: this.resolvedModel() };
  }

  // Batched variant of prepareEmbedding -- ONE Voyage request for the
  // whole set, same reasoning as the old embedExperienceItems batching
  // (resume import, bulk skill add would otherwise blow through
  // Voyage's free-tier 3-requests/minute cap). All-or-nothing: either
  // every text embeds, or the whole batch throws and the caller creates
  // nothing, rather than committing partial progress.
  async prepareEmbeddings(contents: string[]): Promise<PreparedEmbedding[]> {
    if (contents.length === 0) return [];
    const embeddings = await this.voyageClient.embedMany(contents);
    const model = this.resolvedModel();
    return embeddings.map((embedding) => ({ vectorLiteral: toVectorLiteral(embedding), model }));
  }

  // Pure DB write, no external call -- safe to run inside the same
  // transaction as the ExperienceItem create/update it belongs to, which
  // is the whole point: the row and its embedding either both land or
  // neither does. `tx` so this can run as part of a caller's own
  // transaction rather than opening a second one.
  async persistEmbedding(
    tx: Prisma.TransactionClient,
    experienceItemId: string,
    embedding: PreparedEmbedding,
  ): Promise<void> {
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "experience_embeddings" ("id", "experience_item_id", "embedding", "model", "created_at")
      VALUES (${id}, ${experienceItemId}, ${embedding.vectorLiteral}::vector, ${embedding.model}, now())
      ON CONFLICT ("experience_item_id")
      DO UPDATE SET "embedding" = EXCLUDED."embedding", "model" = EXCLUDED."model", "created_at" = now()
    `;
  }

  private resolvedModel(): string {
    return this.configService.get<string>('VOYAGE_EMBEDDING_MODEL') ?? 'voyage-3-lite';
  }

  // Embeds the query text ONCE so callers that need to rank several
  // disjoint type-scoped slices of the same user's items against the same
  // job description (e.g. EXPERIENCE and PROJECT each getting their own
  // top-K) can reuse one vector instead of re-embedding identical text
  // once per slice -- that used to double Voyage usage per generation and
  // made the free-tier 3-requests/minute cap easier to hit.
  async embedQuery(queryText: string): Promise<number[]> {
    return this.voyageClient.embed(queryText);
  }

  // Cosine distance (`<=>`) scoped to one user's own experience items --
  // this is the retrieval half of RAG: find which of the user's own
  // chunks are semantically closest to an already-embedded query vector.
  // `types`, when given, scopes retrieval to those ExperienceTypes --
  // used to rank only EXPERIENCE/PROJECT items by JD relevance, while
  // catalog facts (skills, languages, education, etc.) are fetched in
  // full elsewhere rather than competing for the same top-K slots.
  async findSimilarByEmbedding(
    userId: string,
    embedding: number[],
    limit = 8,
    types?: string[],
  ): Promise<SimilarExperienceItem[]> {
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

  // Convenience wrapper for the (still common) single-query-single-slice
  // case -- embeds then delegates to findSimilarByEmbedding.
  async findSimilarExperienceItems(
    userId: string,
    queryText: string,
    limit = 8,
    types?: string[],
  ): Promise<SimilarExperienceItem[]> {
    const embedding = await this.embedQuery(queryText);
    return this.findSimilarByEmbedding(userId, embedding, limit, types);
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
