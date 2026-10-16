import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import { SearchCandidatesDto } from './dto/search-candidates.dto.js';

const SEARCH_PREVIEW_LIMIT = 20;
const BEST_FIT_SHORTLIST_SIZE = 3;

// Deliberately never selects email/phone -- recruiters see what a candidate
// has done, not how to reach them directly. Contact/messaging is a later
// phase, same way payments were deferred out of the phase-1 MVP.
const CANDIDATE_PUBLIC_SELECT = {
  id: true,
  name: true,
  bio: true,
  location: true,
} as const;

interface ProfileSource {
  bio: string | null;
  experienceItems: { title: string; organization: string | null; description: string | null }[];
}

@Injectable()
export class RecruiterSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
    private readonly claudeClient: ClaudeClient,
    private readonly configService: ConfigService,
  ) {}

  async getMe(recruiterId: string) {
    const recruiter = await this.prisma.recruiter.findUniqueOrThrow({
      where: { id: recruiterId },
      select: {
        id: true,
        email: true,
        name: true,
        companyName: true,
        rankingCreditsUsed: true,
      },
    });
    const limit = this.creditsLimit();
    return { ...recruiter, creditsRemaining: Math.max(0, limit - recruiter.rankingCreditsUsed) };
  }

  // Free, unlimited tier -- cosine similarity only. Ordered internally for a
  // sensible preview, but no score reaches the response: raw embedding
  // distance isn't a meaningful "match percentage" on its own (see the
  // paid tier below for the real analysis).
  async search(dto: SearchCandidatesDto) {
    const [matches, totalCount] = await Promise.all([
      this.vectorService.findSimilarCandidates(dto.query, SEARCH_PREVIEW_LIMIT),
      this.prisma.user.count({
        where: { jobSearchEnabled: true, experienceItems: { some: {} } },
      }),
    ]);
    if (matches.length === 0) return { totalCount, results: [] };

    const users = await this.prisma.user.findMany({
      where: { id: { in: matches.map((match) => match.userId) } },
      select: CANDIDATE_PUBLIC_SELECT,
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    // Retrieval order (closest match first) is the signal -- put results
    // back in that order rather than whatever order findMany returned.
    const results = matches
      .map((match) => {
        const user = userMap.get(match.userId);
        if (!user) return null;
        return {
          ...user,
          matchSnippet: match.organization
            ? `${match.title} at ${match.organization}`
            : match.title,
        };
      })
      .filter((result): result is NonNullable<typeof result> => result !== null);

    return { totalCount, results };
  }

  // Credit-gated tier -- the same cosine shortlist, narrowed to 3, each run
  // through the existing analyzeMatch LLM analysis (the exact one resume
  // generation already uses) for a real 0-100 score and keyword breakdown.
  async findBestFit(recruiterId: string, dto: SearchCandidatesDto) {
    const recruiter = await this.prisma.recruiter.findUniqueOrThrow({
      where: { id: recruiterId },
    });
    if (recruiter.rankingCreditsUsed >= this.creditsLimit()) {
      throw new ForbiddenException(
        'No ranking credits remaining. Each "find best fit" search costs 1 credit.',
      );
    }

    const matches = await this.vectorService.findSimilarCandidates(
      dto.query,
      BEST_FIT_SHORTLIST_SIZE,
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: matches.map((match) => match.userId) } },
      select: { ...CANDIDATE_PUBLIC_SELECT, experienceItems: { select: { title: true, organization: true, description: true } } },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    const analyzed = await Promise.all(
      matches.map(async (match) => {
        const user = userMap.get(match.userId);
        if (!user) return null;
        const analysis = await this.claudeClient.analyzeMatch({
          jobDescription: dto.query,
          resumeContent: this.buildProfileText(user),
        });
        return {
          id: user.id,
          name: user.name,
          bio: user.bio,
          location: user.location,
          matchScore: analysis.matchScore,
          matchedKeywords: analysis.matchedKeywords,
          missingKeywords: analysis.missingKeywords,
        };
      }),
    );

    await this.prisma.recruiter.update({
      where: { id: recruiterId },
      data: { rankingCreditsUsed: { increment: 1 } },
    });

    return analyzed
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort((a, b) => b.matchScore - a.matchScore);
  }

  async getCandidate(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { ...CANDIDATE_PUBLIC_SELECT, jobSearchEnabled: true },
    });
    // Re-checked here, not just at search time -- a candidate may have
    // opted out between a search and a recruiter opening their profile.
    if (!user || !user.jobSearchEnabled) {
      throw new NotFoundException('Candidate not found');
    }

    const experienceItems = await this.prisma.experienceItem.findMany({
      where: { userId: id },
      orderBy: [{ type: 'asc' }, { startDate: 'desc' }],
    });

    return {
      id: user.id,
      name: user.name,
      bio: user.bio,
      location: user.location,
      experienceItems,
    };
  }

  private creditsLimit(): number {
    return Number(this.configService.get('RECRUITER_FREE_CREDITS_LIMIT') ?? 3);
  }

  // Same "title at organization\ndescription" shape buildContent already
  // uses for embeddings in experience-items.service.ts, just concatenated
  // across the whole profile instead of one item at a time -- analyzeMatch
  // wants a block of resume-like text, not a list of chunks.
  private buildProfileText(source: ProfileSource): string {
    const bioLine = source.bio ? `${source.bio}\n\n` : '';
    const itemLines = source.experienceItems
      .map((item) => {
        const header = item.organization ? `${item.title} at ${item.organization}` : item.title;
        return item.description ? `${header}\n${item.description}` : header;
      })
      .join('\n\n');
    return `${bioLine}${itemLines}`;
  }
}
