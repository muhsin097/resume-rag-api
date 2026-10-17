import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import type { ResumeDocument } from '../llm/claude.client.js';
import { CreateResumeGenerationDto } from './dto/create-resume-generation.dto.js';
import { ExperienceType } from '../generated/prisma/enums.js';

// Skills, languages, education, certifications, and achievements are
// comprehensive lists a candidate wants shown in full every time -- not
// trimmed by semantic distance to one JD the way experience/project
// bullets are.
const CATALOG_TYPES: ExperienceType[] = [
  ExperienceType.EDUCATION,
  ExperienceType.SKILL,
  ExperienceType.LANGUAGE,
  ExperienceType.CERTIFICATION,
  ExperienceType.ACHIEVEMENT,
];
// EXPERIENCE and PROJECT each get their own top-K budget, retrieved
// separately -- they used to share a single pool, which meant a candidate
// with several jobs and several projects would have projects crowded out
// entirely (e.g. 4 experience + 8 projects competing for one shared top-8
// left only 4 project slots, dropping half of them even though all were
// relevant). Separate budgets mean neither type can starve the other.
const RANKED_TOP_K: Partial<Record<ExperienceType, number>> = {
  [ExperienceType.EXPERIENCE]: 8,
  [ExperienceType.PROJECT]: 8,
};

// Deterministic, no AI call -- generatedContent stays a flat string (the
// analyzeMatch input, and the display fallback for rows predating
// structuredContent) derived from the same structured data rather than a
// second, possibly-divergent generation.
// Skills/Languages/Achievements items carry an empty title today, but
// older stored generations put the section heading itself in there
// (e.g. title "Skills" under a "SKILLS" heading) -- skip it either way
// rather than printing the heading twice.
function hasOwnItemTitle(item: { title: string }, section: { heading: string }): boolean {
  return Boolean(item.title) && item.title.trim().toLowerCase() !== section.heading.trim().toLowerCase();
}

function flattenResumeDocument(doc: ResumeDocument): string {
  const lines = doc.title ? [doc.name, doc.title, doc.contactLine] : [doc.name, doc.contactLine];
  if (doc.summary) lines.push('', doc.summary);
  for (const section of doc.sections) {
    lines.push('', section.heading.toUpperCase());
    for (const item of section.items) {
      if (hasOwnItemTitle(item, section)) {
        lines.push(item.subtitle ? `${item.title} -- ${item.subtitle}` : item.title);
      }
      for (const bullet of item.bullets) {
        lines.push(`- ${bullet}`);
      }
    }
  }
  return lines.join('\n');
}

@Injectable()
export class ResumeGenerationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
    private readonly claudeClient: ClaudeClient,
    private readonly configService: ConfigService,
  ) {}

  async generate(userId: string, dto: CreateResumeGenerationDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const limit = Number(
      this.configService.get('FREE_GENERATIONS_LIMIT') ?? 5,
    );

    if (user.plan !== 'PREMIUM' && user.freeGenerationsUsed >= limit) {
      throw new ForbiddenException(
        'Free generation limit reached. Upgrade to premium for unlimited generations.',
      );
    }

    const rankedTypeEntries = Object.entries(RANKED_TOP_K) as [ExperienceType, number][];
    // Embed the JD once and reuse it for every ranked type's query, rather
    // than re-embedding the identical text per type (which doubled Voyage
    // usage once EXPERIENCE/PROJECT got split into separate top-K calls).
    const [queryEmbedding, catalogItems] = await Promise.all([
      this.vectorService.embedQuery(dto.jobDescription),
      this.prisma.experienceItem.findMany({
        where: { userId, type: { in: CATALOG_TYPES } },
      }),
    ]);
    const similarByType = await Promise.all(
      rankedTypeEntries.map(([type, topK]) =>
        this.vectorService.findSimilarByEmbedding(userId, queryEmbedding, topK, [type]),
      ),
    );
    const similar = similarByType.flat();
    if (similar.length === 0 && catalogItems.length === 0) {
      throw new ForbiddenException(
        'Add some experience items to your profile before generating a tailored resume.',
      );
    }

    // Retrieval order (closest match first) is the signal -- re-fetch the
    // full rows, then put them back in that order rather than DB order.
    const rankedItems = await this.prisma.experienceItem.findMany({
      where: { id: { in: similar.map((match) => match.id) } },
    });
    const orderedRankedItems = similar
      .map((match) => rankedItems.find((item) => item.id === match.id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const orderedItems = [...orderedRankedItems, ...catalogItems];

    const structuredContent = await this.claudeClient.generateTailoredResume({
      jobDescription: dto.jobDescription,
      facts: orderedItems,
      candidate: {
        name: user.name,
        phone: user.phone,
        location: user.location,
        bio: user.bio,
      },
    });
    const generatedContent = flattenResumeDocument(structuredContent);

    const analysis = await this.claudeClient.analyzeMatch({
      jobDescription: dto.jobDescription,
      resumeContent: generatedContent,
    });

    const generation = await this.prisma.resumeGeneration.create({
      data: {
        userId,
        jobDescription: dto.jobDescription,
        retrievedItemIds: orderedItems.map((item) => item.id),
        generatedContent,
        structuredContent: structuredContent as object,
        matchScore: analysis.matchScore,
        matchedKeywords: analysis.matchedKeywords,
        missingKeywords: analysis.missingKeywords,
      },
    });

    if (user.plan !== 'PREMIUM') {
      await this.prisma.user.update({
        where: { id: userId },
        data: { freeGenerationsUsed: { increment: 1 } },
      });
    }

    return generation;
  }

  findAllForUser(userId: string) {
    return this.prisma.resumeGeneration.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneForUser(userId: string, id: string) {
    const generation = await this.prisma.resumeGeneration.findUnique({
      where: { id },
    });
    if (!generation || generation.userId !== userId) {
      throw new NotFoundException('Resume generation not found');
    }
    return generation;
  }
}
