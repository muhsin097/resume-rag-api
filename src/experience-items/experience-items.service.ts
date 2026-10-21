import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { ClaudeClient } from '../llm/claude.client.js';
import { CreateExperienceItemDto } from './dto/create-experience-item.dto.js';
import { UpdateExperienceItemDto } from './dto/update-experience-item.dto.js';

interface ContentSource {
  title: string;
  organization?: string | null;
  description?: string | null;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

@Injectable()
export class ExperienceItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
    private readonly claudeClient: ClaudeClient,
  ) {}

  findAllForUser(userId: string) {
    return this.prisma.experienceItem.findMany({
      where: { userId },
      orderBy: [{ type: 'asc' }, { startDate: 'desc' }],
    });
  }

  async findOneForUser(userId: string, id: string) {
    const item = await this.prisma.experienceItem.findUnique({
      where: { id },
    });
    if (!item || item.userId !== userId) {
      throw new NotFoundException('Experience item not found');
    }
    return item;
  }

  async create(userId: string, dto: CreateExperienceItemDto) {
    const existing = await this.findDuplicate(userId, dto);
    if (existing) {
      throw new ConflictException(
        'This is already in your profile (same type, title, and organization).',
      );
    }

    const item = await this.prisma.experienceItem.create({
      data: {
        userId,
        type: dto.type,
        title: dto.title,
        organization: dto.organization,
        description: dto.description,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        startDatePrecision: dto.startDatePrecision,
        endDatePrecision: dto.endDatePrecision,
        isCurrent: dto.isCurrent ?? false,
        content: this.buildContent(dto),
      },
    });

    await this.vectorService.embedExperienceItem(item.id, item.content);
    if (item.type === 'SKILL') {
      await this.categorizeAndPersist([item]);
    }
    return item;
  }

  // Creates several items with ONE Voyage request for all their embeddings
  // combined, instead of one request per item -- used by resume import and
  // bulk skill add, which would otherwise blow through the free-tier rate
  // limit (3 requests/minute) the moment more than a couple of items land
  // in the same minute.
  //
  // Silently skips anything that's already in the profile (same type,
  // title, organization) rather than erroring the whole batch -- import
  // naturally gets re-run (a retry, re-uploading an updated resume), and
  // without this every re-run duplicated the entire profile.
  async createMany(userId: string, dtos: CreateExperienceItemDto[]) {
    const existingItems = await this.prisma.experienceItem.findMany({
      where: { userId },
      select: { type: true, title: true, organization: true },
    });
    const seen = new Set(
      existingItems.map((item) =>
        [item.type, normalize(item.title), normalize(item.organization)].join(' '),
      ),
    );

    const items = [];
    for (const dto of dtos) {
      const key = [dto.type, normalize(dto.title), normalize(dto.organization)].join(' ');
      if (seen.has(key)) continue;
      seen.add(key);

      const item = await this.prisma.experienceItem.create({
        data: {
          userId,
          type: dto.type,
          title: dto.title,
          organization: dto.organization,
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          startDatePrecision: dto.startDatePrecision,
          endDatePrecision: dto.endDatePrecision,
          isCurrent: dto.isCurrent ?? false,
          content: this.buildContent(dto),
        },
      });
      items.push(item);
    }

    if (items.length > 0) {
      await this.vectorService.embedExperienceItems(
        items.map((item) => ({ id: item.id, content: item.content })),
      );
    }

    const newSkills = items.filter((item) => item.type === 'SKILL');
    if (newSkills.length > 0) {
      await this.categorizeAndPersist(newSkills);
    }

    return items;
  }

  // One Claude call for the whole new-skills batch, not one per skill --
  // the result is persisted on each row (ExperienceItem.category), so this
  // never runs again for these skills: not on later tailored generations,
  // and not on the general resume export, which deliberately never calls
  // Claude at all. Best-effort: if categorization fails, the skills are
  // simply left uncategorized (grouped under "Other" at render time)
  // rather than failing the whole add/import.
  private async categorizeAndPersist(skills: { id: string; title: string }[]): Promise<void> {
    try {
      const assignments = await this.claudeClient.categorizeSkills(
        skills.map((s) => s.title),
      );
      const categoryByTitle = new Map(
        assignments.map((a) => [a.skill.trim().toLowerCase(), a.category]),
      );
      await Promise.all(
        skills.map((skill) => {
          const category = categoryByTitle.get(skill.title.trim().toLowerCase());
          if (!category) return Promise.resolve();
          return this.prisma.experienceItem.update({
            where: { id: skill.id },
            data: { category },
          });
        }),
      );
    } catch {
      // Swallowed deliberately -- see comment above.
    }
  }

  private findDuplicate(userId: string, dto: { type: string; title: string; organization?: string | null }) {
    return this.prisma.experienceItem.findFirst({
      where: {
        userId,
        type: dto.type as never,
        title: { equals: dto.title.trim(), mode: 'insensitive' },
        organization: dto.organization?.trim()
          ? { equals: dto.organization.trim(), mode: 'insensitive' }
          : null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateExperienceItemDto) {
    const existing = await this.findOneForUser(userId, id);

    const item = await this.prisma.experienceItem.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        content: this.buildContent({ ...existing, ...dto }),
      },
    });

    await this.vectorService.embedExperienceItem(item.id, item.content);
    return item;
  }

  async remove(userId: string, id: string) {
    await this.findOneForUser(userId, id);
    await this.prisma.experienceItem.delete({ where: { id } });
  }

  // The text that actually gets embedded in the RAG pipeline (task 4) --
  // kept in one place so create/update can't drift out of sync with it.
  private buildContent(item: ContentSource): string {
    const header = item.organization
      ? `${item.title} at ${item.organization}`
      : item.title;
    return item.description ? `${header}\n${item.description}` : header;
  }
}
