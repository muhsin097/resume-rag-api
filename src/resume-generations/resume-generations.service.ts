import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import type { ResumeDocument } from '../llm/claude.client.js';
import { CreateResumeGenerationDto } from './dto/create-resume-generation.dto.js';
import { ExperienceType } from '../generated/prisma/enums.js';
import { buildDeterministicSections } from './deterministic-sections.js';
import { ExperienceItemsService } from '../experience-items/experience-items.service.js';

// Education/Skills/Languages/Certifications are built deterministically in
// code (deterministic-sections.ts) -- they never need JD-aware rewriting,
// so they're fetched in full but never sent to Claude at all. ACHIEVEMENT
// is the one catalog type that still goes to the model, since "fold this
// into the right Experience role instead of listing it separately" is a
// judgment call worth an LLM.
const DETERMINISTIC_TYPES: ExperienceType[] = [
  ExperienceType.EDUCATION,
  ExperienceType.SKILL,
  ExperienceType.LANGUAGE,
  ExperienceType.CERTIFICATION,
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
    private readonly experienceItemsService: ExperienceItemsService,
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
    const [queryEmbedding, rawDeterministicItems, achievementItems] = await Promise.all([
      this.vectorService.embedQuery(dto.jobDescription),
      this.prisma.experienceItem.findMany({
        where: { userId, type: { in: DETERMINISTIC_TYPES } },
      }),
      this.prisma.experienceItem.findMany({
        where: { userId, type: ExperienceType.ACHIEVEMENT },
      }),
    ]);
    const similarByType = await Promise.all(
      rankedTypeEntries.map(([type, topK]) =>
        this.vectorService.findSimilarByEmbedding(userId, queryEmbedding, topK, [type]),
      ),
    );
    const similar = similarByType.flat();
    if (similar.length === 0 && rawDeterministicItems.length === 0 && achievementItems.length === 0) {
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

    // deterministicItems is mutable: an approved "add missing keyword" request
    // with saveToProfile=true appends a freshly-persisted SKILL row below, so
    // it flows into buildDeterministicSections exactly like any other fact.
    const deterministicItems = [...rawDeterministicItems];
    const extraSkillTitles: string[] = [];
    if (dto.requestedSkills && dto.requestedSkills.length > 0) {
      const candidateSkills = deterministicItems
        .filter((item) => item.type === ExperienceType.SKILL)
        .map((item) => item.title);
      const candidateExperienceSummary = [...orderedRankedItems, ...achievementItems]
        .map((item) => item.content)
        .filter((text): text is string => Boolean(text))
        .join(' ');
      const classifications = await this.claudeClient.classifySkillKeywords({
        keywords: dto.requestedSkills.map((requested) => requested.keyword),
        candidateSkills,
        candidateExperienceSummary,
      });
      for (const requested of dto.requestedSkills) {
        const classification = classifications.find(
          (c) => c.keyword.toLowerCase() === requested.keyword.toLowerCase(),
        );
        if (!classification?.approved) continue;
        const normalizedTitle = classification.normalizedTitle || requested.keyword;
        if (requested.saveToProfile) {
          try {
            const created = await this.experienceItemsService.create(userId, {
              type: ExperienceType.SKILL,
              title: normalizedTitle,
            });
            deterministicItems.push(created);
          } catch {
            // Already exists as a SKILL fact (ConflictException from the
            // dedupe check) -- nothing to add, carry on.
          }
        } else {
          extraSkillTitles.push(normalizedTitle);
        }
      }
    }

    // Everything considered for this generation, for provenance/debugging
    // (retrievedItemIds) -- deterministic items included even though they
    // never reach Claude, since they still end up in the final document.
    const orderedItems = [...orderedRankedItems, ...achievementItems, ...deterministicItems];

    const structuredContent = await this.claudeClient.generateTailoredResume({
      jobDescription: dto.jobDescription,
      facts: [...orderedRankedItems, ...achievementItems],
      candidate: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        location: user.location,
        bio: user.bio,
      },
    });

    // Splice in the deterministic sections Claude never saw: Skills right
    // after the summary, Education/Languages/Certifications after
    // Experience/Projects but before a trailing standalone Achievements
    // section (if Claude didn't fold every achievement into a role).
    const { skills, rest } = buildDeterministicSections(
      deterministicItems,
      dto.jobDescription,
      extraSkillTitles,
    );
    const achievementsHeadingIndex = structuredContent.sections.findIndex(
      (s) => s.heading === 'Achievements',
    );
    const beforeAchievements =
      achievementsHeadingIndex === -1
        ? structuredContent.sections
        : structuredContent.sections.slice(0, achievementsHeadingIndex);
    const achievementsSection =
      achievementsHeadingIndex === -1 ? [] : [structuredContent.sections[achievementsHeadingIndex]];
    structuredContent.sections = [
      ...(skills ? [skills] : []),
      ...beforeAchievements,
      ...rest,
      ...achievementsSection,
    ];

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
