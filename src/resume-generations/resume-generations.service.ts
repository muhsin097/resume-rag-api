import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import { CreateResumeGenerationDto } from './dto/create-resume-generation.dto.js';

const RETRIEVAL_TOP_K = 8;

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

    const similar = await this.vectorService.findSimilarExperienceItems(
      userId,
      dto.jobDescription,
      RETRIEVAL_TOP_K,
    );
    if (similar.length === 0) {
      throw new ForbiddenException(
        'Add some experience items to your profile before generating a tailored resume.',
      );
    }

    // Retrieval order (closest match first) is the signal -- re-fetch the
    // full rows, then put them back in that order rather than DB order.
    const items = await this.prisma.experienceItem.findMany({
      where: { id: { in: similar.map((match) => match.id) } },
    });
    const orderedItems = similar
      .map((match) => items.find((item) => item.id === match.id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const generatedContent = await this.claudeClient.generateTailoredResume({
      jobDescription: dto.jobDescription,
      facts: orderedItems,
      candidate: {
        name: user.name,
        phone: user.phone,
        location: user.location,
        bio: user.bio,
      },
    });

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
