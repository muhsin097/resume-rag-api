import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

    const content = this.buildContent(dto);
    // Embedded BEFORE anything is written -- if Voyage fails (rate
    // limit, network blip, outage), this throws here and NOTHING is
    // created, so a retry just works normally instead of hitting
    // findDuplicate's ConflictException against an orphaned row with no
    // embedding and no way to repair it. See VectorService.prepareEmbedding.
    const embedding = await this.vectorService.prepareEmbedding(content);

    const item = await this.prisma.$transaction(async (tx) => {
      const created = await tx.experienceItem.create({
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
          content,
        },
      });
      await this.vectorService.persistEmbedding(tx, created.id, embedding);
      return created;
    });

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

    const toCreate: { dto: CreateExperienceItemDto; content: string }[] = [];
    for (const dto of dtos) {
      const key = [dto.type, normalize(dto.title), normalize(dto.organization)].join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      toCreate.push({ dto, content: this.buildContent(dto) });
    }

    if (toCreate.length === 0) return [];

    // Embeds the WHOLE batch before creating anything -- all-or-nothing,
    // same reasoning as create() above. A failure here used to leave
    // however many items had already been created (loop committed each
    // row immediately, batch embed ran once at the end) permanently
    // orphaned with no embedding; now either the whole batch lands with
    // embeddings or nothing is created at all, and a retry (re-run
    // import, re-submit the bulk add) just works.
    const embeddings = await this.vectorService.prepareEmbeddings(
      toCreate.map((entry) => entry.content),
    );

    const items = await this.prisma.$transaction(async (tx) => {
      const created = [];
      for (let i = 0; i < toCreate.length; i++) {
        const { dto, content } = toCreate[i];
        const item = await tx.experienceItem.create({
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
            content,
          },
        });
        await this.vectorService.persistEmbedding(tx, item.id, embeddings[i]);
        created.push(item);
      }
      return created;
    });

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

    if (dto.isHighlighted === true && existing.type !== 'PROJECT') {
      throw new BadRequestException('Only projects can be highlighted.');
    }

    const content = this.buildContent({ ...existing, ...dto });
    // Embedded BEFORE the update commits -- the old order (update
    // content, then embed) left the OLD embedding in place, now silently
    // mismatched with the new content, if the Voyage call failed after
    // the content change had already landed. Failing here instead means
    // the whole update is rejected and existing.content/its embedding
    // stay consistent with each other.
    const embedding = await this.vectorService.prepareEmbedding(content);

    const item = await this.prisma.$transaction(async (tx) => {
      // At most one highlighted project per user -- unset any previous
      // one in the same transaction as setting this one, so a concurrent
      // read never briefly sees two.
      if (dto.isHighlighted === true) {
        await tx.experienceItem.updateMany({
          where: { userId, type: 'PROJECT', isHighlighted: true, id: { not: id } },
          data: { isHighlighted: false },
        });
      }

      const updated = await tx.experienceItem.update({
        where: { id },
        data: {
          ...dto,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          content,
        },
      });
      await this.vectorService.persistEmbedding(tx, updated.id, embedding);
      return updated;
    });

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
