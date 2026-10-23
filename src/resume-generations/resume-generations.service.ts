import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import type { ExperienceFact, MatchAnalysis, ResumeDocument } from '../llm/claude.client.js';
import { CreateResumeGenerationDto } from './dto/create-resume-generation.dto.js';
import { AddSkillDto } from './dto/add-skill.dto.js';
import { ExperienceType } from '../generated/prisma/enums.js';
import { buildContactLine, buildDeterministicSections, buildItemFromFact } from './deterministic-sections.js';
import { ExperienceItemsService } from '../experience-items/experience-items.service.js';

// Credit unit is finer than "one generation" -- a full regenerate does
// the expensive bullet-writing call plus a rescore, a standalone rescore
// only reruns analyzeMatch (genuinely half the cost, since the Skills
// list is never sent to the bullet-writing call at all -- see
// addSkillToGeneration). Adding a skill itself is free: it's a plain DB
// write, no LLM call of any kind.
const FULL_GENERATION_COST = 2;
const RESCORE_COST = 1;

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

// Safety net for analyzeMatch: on a long, dense skills line the model
// sometimes loses track of a keyword it already saw and reports it as
// missing anyway. Word-boundary-safe so short keywords ("AI", "Git") can't
// false-positive inside unrelated words ("email", "digital"), and treats
// ".", "-", "/", and whitespace as interchangeable so "CI/CD" also matches
// "CI-CD" or "CI CD", "Node.js" also matches "Node JS", etc.
function keywordAppearsInResume(keyword: string, resumeText: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/[\s\-/.]+/g, '[\\s\\-/.]*');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(resumeText);
}

// Shared by a fresh generation and a standalone rescore -- reconciles
// Claude's matched/missing lists against the actual resume text (the
// keywordAppearsInResume safety net), then derives keywordCoverage
// deterministically from the result rather than trusting the model's own
// ratio. Used identically in both places so a rescore after adding a
// skill produces the exact same kind of score a fresh generation would.
function reconcileKeywordMatches(
  analysis: MatchAnalysis,
  resumeText: string,
): { matchedKeywords: string[]; missingKeywords: string[]; keywordCoverage: number } {
  const matchedKeywords = [...analysis.matchedKeywords];
  const missingKeywords: string[] = [];
  for (const keyword of analysis.missingKeywords) {
    if (keywordAppearsInResume(keyword, resumeText)) {
      matchedKeywords.push(keyword);
    } else {
      missingKeywords.push(keyword);
    }
  }
  const totalKeywords = matchedKeywords.length + missingKeywords.length;
  const keywordCoverage =
    totalKeywords === 0 ? analysis.fitScore : Math.round((matchedKeywords.length / totalKeywords) * 100);
  return { matchedKeywords, missingKeywords, keywordCoverage };
}

// Claude returns Experience/Project facts in JD-relevance order, not date
// order -- display still wants most-recent-first, same as every other
// section. A fact with no start date (shouldn't normally happen for these
// two types, but not guaranteed) sorts last rather than crashing the
// comparator.
function compareFactsByStartDateDesc(
  a: { startDate?: Date | string | null },
  b: { startDate?: Date | string | null },
): number {
  const aTime = a.startDate ? new Date(a.startDate).getTime() : null;
  const bTime = b.startDate ? new Date(b.startDate).getTime() : null;
  if (aTime === null && bTime === null) return 0;
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  return bTime - aTime;
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
      if (section.heading === 'Skills' && item.bullets.length > 0) {
        lines.push(item.bullets.join(', '));
      } else {
        for (const bullet of item.bullets) {
          lines.push(`- ${bullet}`);
        }
      }
    }
  }
  return lines.join('\n');
}

@Injectable()
export class ResumeGenerationsService {
  private readonly logger = new Logger(ResumeGenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
    private readonly claudeClient: ClaudeClient,
    private readonly experienceItemsService: ExperienceItemsService,
  ) {}

  async generate(userId: string, dto: CreateResumeGenerationDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    // Reserved BEFORE any Claude calls, as one atomic conditional UPDATE --
    // not a separate check-then-act (read balance, decide, increment
    // later), which would let two concurrent requests both read the same
    // stale balance, both pass, and both get charged to Claude even
    // though only enough credits for one was actually available. The
    // WHERE clause and the decrement happen in the same statement, so
    // Postgres's row lock serializes concurrent attempts correctly -- the
    // second one re-reads the just-committed balance before its own
    // WHERE is evaluated.
    const creditReserved = await this.reserveGenerationCredit(userId, user.plan, FULL_GENERATION_COST);

    try {
      return await this.performGeneration(userId, user, dto);
    } catch (err) {
      if (creditReserved) {
        await this.prisma.user
          .update({ where: { id: userId }, data: { creditsBalance: { increment: FULL_GENERATION_COST } } })
          .catch((refundErr) => {
            this.logger.error(
              `Failed to refund reserved credits for user ${userId} after a failed generation`,
              refundErr instanceof Error ? refundErr.stack : refundErr,
            );
          });
      }
      throw err;
    }
  }

  // Add a confirmed skill to an existing generation's Skills section --
  // no LLM call, no credit charge. The skill never reaches
  // generateTailoredResume (it's excluded from the facts array there), so
  // it's architecturally impossible for this to affect Experience/Project
  // bullets -- only the deterministic Skills line changes. Score is left
  // as-is; call rescoreGeneration separately (1 credit) to refresh it.
  async addSkillToGeneration(userId: string, generationId: string, dto: AddSkillDto) {
    const generation = await this.findOneForUser(userId, generationId);
    if (!generation.structuredContent) {
      throw new BadRequestException(
        'This resume predates structured editing and cannot have skills added directly.',
      );
    }

    const title = dto.keyword.trim();
    if (!title) {
      throw new BadRequestException('Keyword cannot be empty.');
    }

    const extraSkillTitles: string[] = [];
    if (dto.saveToProfile) {
      try {
        await this.experienceItemsService.create(userId, { type: ExperienceType.SKILL, title });
      } catch {
        // Already exists as a SKILL fact (ConflictException from the
        // dedupe check) -- nothing to add, it'll show up below via the
        // fresh DB read regardless.
      }
    } else {
      extraSkillTitles.push(title);
    }

    // Re-fetch deterministic items fresh (now includes the just-created
    // SKILL row, if saveToProfile) and rebuild only the Skills section --
    // every other section (Experience/Projects/Education/etc.) in the
    // stored document is left untouched.
    const deterministicItems = await this.prisma.experienceItem.findMany({
      where: { userId, type: { in: DETERMINISTIC_TYPES } },
    });
    const { skills } = buildDeterministicSections(deterministicItems, generation.jobDescription, extraSkillTitles);

    const doc = generation.structuredContent as unknown as ResumeDocument;
    const nonSkillSections = doc.sections.filter((section) => section.heading !== 'Skills');
    // Skills always goes first, right after the summary -- same position
    // performGeneration originally placed it in.
    const updatedDoc: ResumeDocument = {
      ...doc,
      sections: skills ? [skills, ...nonSkillSections] : nonSkillSections,
    };
    const updatedContent = flattenResumeDocument(updatedDoc);

    return this.prisma.resumeGeneration.update({
      where: { id: generationId },
      data: { structuredContent: updatedDoc as object, generatedContent: updatedContent },
    });
  }

  // Standalone rescore -- 1 credit, reruns only analyzeMatch against the
  // generation's current content (which may already include skills added
  // for free since the original generation). Never calls
  // generateTailoredResume: bullets can't be affected by a Skills-only
  // change, so re-running the expensive call would just reproduce the
  // same output at temperature:0 for no benefit.
  async rescoreGeneration(userId: string, generationId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const generation = await this.findOneForUser(userId, generationId);

    const creditReserved = await this.reserveGenerationCredit(userId, user.plan, RESCORE_COST);

    try {
      const analysis = await this.claudeClient.analyzeMatch({
        jobDescription: generation.jobDescription,
        resumeContent: generation.generatedContent,
      });
      const { matchedKeywords, missingKeywords, keywordCoverage } = reconcileKeywordMatches(
        analysis,
        generation.generatedContent,
      );

      return await this.prisma.resumeGeneration.update({
        where: { id: generationId },
        data: { fitScore: analysis.fitScore, keywordCoverage, matchedKeywords, missingKeywords },
      });
    } catch (err) {
      if (creditReserved) {
        await this.prisma.user
          .update({ where: { id: userId }, data: { creditsBalance: { increment: RESCORE_COST } } })
          .catch((refundErr) => {
            this.logger.error(
              `Failed to refund reserved credits for user ${userId} after a failed rescore`,
              refundErr instanceof Error ? refundErr.stack : refundErr,
            );
          });
      }
      throw err;
    }
  }

  private async reserveGenerationCredit(userId: string, plan: string, amount: number): Promise<boolean> {
    // PREMIUM is the legacy/admin-only unlimited grandfather flag --
    // nothing to reserve, never decremented.
    if (plan === 'PREMIUM') return false;

    const now = new Date();
    // creditsExpireAt was always written on purchase but never actually
    // checked anywhere -- an expired balance was silently still spendable.
    // Included directly in the atomic WHERE (not a separate pre-check)
    // so the race-condition guarantee from the original fix still holds.
    const reserved = await this.prisma.user.updateMany({
      where: {
        id: userId,
        creditsBalance: { gte: amount },
        OR: [{ creditsExpireAt: null }, { creditsExpireAt: { gt: now } }],
      },
      data: { creditsBalance: { decrement: amount } },
    });
    if (reserved.count === 0) {
      // Distinguish "you have an expired balance" from "you have nothing"
      // -- the fix only needs a read here, not part of the atomic
      // decrement itself, so it doesn't reopen the race window.
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { creditsBalance: true, creditsExpireAt: true },
      });
      if (current && current.creditsBalance > 0 && current.creditsExpireAt && current.creditsExpireAt <= now) {
        throw new ForbiddenException(
          'Your generation credits have expired. Buy a credit pack to generate more tailored resumes.',
        );
      }
      throw new ForbiddenException(
        'Not enough generation credits remaining. Buy a credit pack to generate more tailored resumes.',
      );
    }
    return true;
  }

  private async performGeneration(
    userId: string,
    user: { bio: string | null; name: string; email: string; phone: string | null; location: string | null; linkedinUrl: string | null; githubUrl: string | null; websiteUrl: string | null },
    dto: CreateResumeGenerationDto,
  ) {
    const rankedTypeEntries = Object.entries(RANKED_TOP_K) as [ExperienceType, number][];
    // Embed the JD once and reuse it for every ranked type's query, rather
    // than re-embedding the identical text per type (which doubled Voyage
    // usage once EXPERIENCE/PROJECT got split into separate top-K calls).
    // jobMeta only depends on the JD text, so it runs alongside retrieval
    // rather than as an extra sequential round-trip.
    const [queryEmbedding, rawDeterministicItems, achievementItems, jobMeta] = await Promise.all([
      this.vectorService.embedQuery(dto.jobDescription),
      this.prisma.experienceItem.findMany({
        where: { userId, type: { in: DETERMINISTIC_TYPES } },
      }),
      this.prisma.experienceItem.findMany({
        where: { userId, type: ExperienceType.ACHIEVEMENT },
      }),
      this.claudeClient.extractJobMeta(dto.jobDescription),
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

    // Adding a JD-relevant skill after the fact is a separate, free,
    // zero-LLM action now (see addSkillToGeneration) -- a fresh
    // generation always starts from exactly the candidate's current
    // profile, no requested-skills plumbing needed here.
    const deterministicItems = rawDeterministicItems;

    // Everything considered for this generation, for provenance/debugging
    // (retrievedItemIds) -- deterministic items included even though they
    // never reach Claude, since they still end up in the final document.
    const orderedItems = [...orderedRankedItems, ...achievementItems, ...deterministicItems];

    // orderedRankedItems can only be EXPERIENCE/PROJECT rows (RANKED_TOP_K
    // only queries those two types), and achievementItems is always
    // fetched with type: ACHIEVEMENT -- both casts are narrowing a type
    // Prisma already guarantees, not asserting something unverified.
    const facts: ExperienceFact[] = [
      ...orderedRankedItems.map((item) => ({ ...item, type: item.type as 'EXPERIENCE' | 'PROJECT' })),
      ...achievementItems.map((item) => ({ ...item, type: 'ACHIEVEMENT' as const })),
    ];
    const factsById = new Map(facts.map((fact) => [fact.id, fact]));

    const generated = await this.claudeClient.generateTailoredResume({
      jobDescription: dto.jobDescription,
      facts,
      bio: user.bio,
    });

    // Every returned factId is checked against the facts actually sent for
    // THIS user before being trusted -- a hallucinated or mismatched id
    // (wrong type, or one that was never in the batch) is dropped rather
    // than silently used to look up the wrong employer/dates. This also
    // means title/subtitle/employer/dates for these sections can never
    // drift from what's actually stored, the same guarantee
    // Education/Certifications/etc. already have.
    const experienceSectionItems = this.resolveFactItems(generated.experienceItems, factsById, 'EXPERIENCE')
      .sort((a, b) => compareFactsByStartDateDesc(a.fact, b.fact))
      .map(({ fact, bullets }) => buildItemFromFact(fact, bullets));
    const projectSectionItems = this.resolveFactItems(generated.projectItems, factsById, 'PROJECT')
      .sort((a, b) => compareFactsByStartDateDesc(a.fact, b.fact))
      .map(({ fact, bullets }) => buildItemFromFact(fact, bullets));
    const standaloneAchievements = generated.achievements
      .filter((entry) => {
        const fact = factsById.get(entry.factId);
        if (!fact || fact.type !== 'ACHIEVEMENT') {
          this.logger.warn(`Dropping achievement with unresolvable factId ${entry.factId}`);
          return false;
        }
        return true;
      })
      .map((entry) => entry.bullet);

    // Splice everything into the same section order as before: Skills
    // right after the summary, Experience/Projects, then
    // Education/Languages/Certifications, then a trailing standalone
    // Achievements section (only the achievements that didn't get folded
    // into a role above).
    const { skills, rest } = buildDeterministicSections(deterministicItems, dto.jobDescription);
    const structuredContent: ResumeDocument = {
      name: user.name,
      title: generated.title,
      contactLine: buildContactLine(user),
      summary: generated.summary,
      sections: [
        ...(skills ? [skills] : []),
        ...(experienceSectionItems.length > 0 ? [{ heading: 'Experience', items: experienceSectionItems }] : []),
        ...(projectSectionItems.length > 0 ? [{ heading: 'Projects', items: projectSectionItems }] : []),
        ...rest,
        ...(standaloneAchievements.length > 0
          ? [{ heading: 'Achievements', items: [{ title: '', subtitle: null, bullets: standaloneAchievements }] }]
          : []),
      ],
    };

    const generatedContent = flattenResumeDocument(structuredContent);

    const analysis = await this.claudeClient.analyzeMatch({
      jobDescription: dto.jobDescription,
      resumeContent: generatedContent,
    });

    // keywordCoverage is computed here, not trusted from the model -- see
    // reconcileKeywordMatches. fitScore, by contrast, is kept as Claude's
    // own holistic judgment, used as-is -- it's a deliberately separate
    // signal (overall candidate fit, not just literal JD keyword
    // presence) rather than a second copy of the same ratio.
    const { matchedKeywords, missingKeywords, keywordCoverage } = reconcileKeywordMatches(
      analysis,
      generatedContent,
    );

    const generation = await this.prisma.resumeGeneration.create({
      data: {
        userId,
        jobDescription: dto.jobDescription,
        jobTitle: jobMeta.jobTitle,
        companyName: jobMeta.companyName,
        retrievedItemIds: orderedItems.map((item) => item.id),
        generatedContent,
        structuredContent: structuredContent as object,
        fitScore: analysis.fitScore,
        keywordCoverage,
        matchedKeywords,
        missingKeywords,
      },
    });

    // The credit itself was already deducted atomically in
    // reserveGenerationCredit, before any of the Claude calls above --
    // nothing left to charge here now that the generation has actually
    // succeeded.
    return generation;
  }

  // Validates every factId Claude returned against the facts actually
  // sent for this user, before any of it is used to build a resume
  // section -- a factId that doesn't resolve, or resolves to the wrong
  // type (e.g. an ACHIEVEMENT id showing up in experienceItems), is
  // dropped rather than trusted. This is the ownership/bounds check that
  // makes the factId citation meaningful instead of just a string Claude
  // could put anything in.
  private resolveFactItems(
    entries: { factId: string; bullets: string[] }[],
    factsById: Map<string, ExperienceFact>,
    expectedType: 'EXPERIENCE' | 'PROJECT',
  ): { fact: ExperienceFact; bullets: string[] }[] {
    const resolved: { fact: ExperienceFact; bullets: string[] }[] = [];
    for (const entry of entries) {
      const fact = factsById.get(entry.factId);
      if (!fact || fact.type !== expectedType) {
        this.logger.warn(
          `Dropping ${expectedType.toLowerCase()} item with unresolvable factId ${entry.factId}`,
        );
        continue;
      }
      resolved.push({ fact, bullets: entry.bullets });
    }
    return resolved;
  }

  async findAllForUser(userId: string, page = 1, limit = 10) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const [items, total] = await Promise.all([
      this.prisma.resumeGeneration.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.resumeGeneration.count({ where: { userId } }),
    ]);
    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    };
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
