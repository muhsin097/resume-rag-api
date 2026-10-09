import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VectorService } from '../vector/vector.service.js';
import { CreateExperienceItemDto } from './dto/create-experience-item.dto.js';
import { UpdateExperienceItemDto } from './dto/update-experience-item.dto.js';

interface ContentSource {
  title: string;
  organization?: string | null;
  description?: string | null;
}

@Injectable()
export class ExperienceItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorService: VectorService,
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
    const item = await this.prisma.experienceItem.create({
      data: {
        userId,
        type: dto.type,
        title: dto.title,
        organization: dto.organization,
        description: dto.description,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        content: this.buildContent(dto),
      },
    });

    await this.vectorService.embedExperienceItem(item.id, item.content);
    return item;
  }

  // Creates several items with ONE Voyage request for all their embeddings
  // combined, instead of one request per item -- used by resume import and
  // bulk skill add, which would otherwise blow through the free-tier rate
  // limit (3 requests/minute) the moment more than a couple of items land
  // in the same minute.
  async createMany(userId: string, dtos: CreateExperienceItemDto[]) {
    const items = [];
    for (const dto of dtos) {
      const item = await this.prisma.experienceItem.create({
        data: {
          userId,
          type: dto.type,
          title: dto.title,
          organization: dto.organization,
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          content: this.buildContent(dto),
        },
      });
      items.push(item);
    }

    await this.vectorService.embedExperienceItems(
      items.map((item) => ({ id: item.id, content: item.content })),
    );
    return items;
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
