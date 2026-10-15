import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { SearchCandidatesDto } from './dto/search-candidates.dto.js';

const SEARCH_RESULTS_LIMIT = 10;

// Deliberately never selects email/phone -- recruiters see what a candidate
// has done, not how to reach them directly. Contact/messaging is a later
// phase, same way payments were deferred out of the phase-1 MVP.
const CANDIDATE_PUBLIC_SELECT = {
  id: true,
  name: true,
  bio: true,
  location: true,
} as const;

@Injectable()
export class RecruiterSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
  ) {}

  async search(dto: SearchCandidatesDto) {
    const matches = await this.vectorService.findSimilarCandidates(
      dto.query,
      SEARCH_RESULTS_LIMIT,
    );
    if (matches.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: matches.map((match) => match.userId) } },
      select: CANDIDATE_PUBLIC_SELECT,
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    // Retrieval order (closest match first) is the signal -- put results
    // back in that order rather than whatever order findMany returned.
    return matches
      .map((match) => {
        const user = userMap.get(match.userId);
        if (!user) return null;
        return {
          ...user,
          distance: match.distance,
          matchSnippet: match.organization
            ? `${match.title} at ${match.organization}`
            : match.title,
        };
      })
      .filter((result): result is NonNullable<typeof result> => result !== null);
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
}
