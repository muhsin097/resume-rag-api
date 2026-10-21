import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { ListExperienceItemsQueryDto } from './dto/list-experience-items-query.dto.js';
import { ListGenerationsQueryDto } from './dto/list-generations-query.dto.js';

const USER_SUMMARY_SELECT = {
  id: true,
  email: true,
  name: true,
  plan: true,
  jobSearchEnabled: true,
  freeGenerationsUsed: true,
  createdAt: true,
  _count: { select: { experienceItems: true, resumeGenerations: true } },
} as const;

const TOP_SKILLS_LIMIT = 10;
const TREND_DAYS = 30;

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    const [userCount, generationCount, itemsByType, scoreAgg, skillGroups, recentGenerations] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.resumeGeneration.count(),
        this.prisma.experienceItem.groupBy({
          by: ['type'],
          _count: { _all: true },
        }),
        this.prisma.resumeGeneration.aggregate({ _avg: { fitScore: true } }),
        this.prisma.experienceItem.groupBy({
          by: ['title'],
          where: { type: 'SKILL' },
          _count: { _all: true },
          orderBy: { _count: { title: 'desc' } },
          take: TOP_SKILLS_LIMIT,
        }),
        this.prisma.resumeGeneration.findMany({
          where: {
            createdAt: { gte: new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000) },
          },
          select: { createdAt: true },
        }),
      ]);

    const itemCount = itemsByType.reduce((sum, row) => sum + row._count._all, 0);

    return {
      userCount,
      itemCount,
      itemsByType: itemsByType.map((row) => ({ type: row.type, count: row._count._all })),
      generationCount,
      avgMatchScore: Math.round(scoreAgg._avg.fitScore ?? 0),
      topSkills: skillGroups.map((row) => ({ title: row.title, count: row._count._all })),
      generationsByDay: this.bucketByDay(recentGenerations.map((row) => row.createdAt)),
    };
  }

  private bucketByDay(dates: Date[]) {
    const counts = new Map<string, number>();
    for (const date of dates) {
      const key = date.toISOString().slice(0, 10);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }

  listUsers(query: ListUsersQueryDto) {
    return this.prisma.user.findMany({
      select: USER_SUMMARY_SELECT,
      orderBy: { [query.sortBy ?? 'createdAt']: query.order ?? 'desc' },
    });
  }

  async getUserDetail(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        location: true,
        bio: true,
        plan: true,
        jobSearchEnabled: true,
        freeGenerationsUsed: true,
        createdAt: true,
      },
    });
    const [experienceItems, resumeGenerations] = await Promise.all([
      this.prisma.experienceItem.findMany({
        where: { userId: id },
        orderBy: [{ type: 'asc' }, { startDate: 'desc' }],
      }),
      this.prisma.resumeGeneration.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { ...user, experienceItems, resumeGenerations };
  }

  listExperienceItems(query: ListExperienceItemsQueryDto) {
    return this.prisma.experienceItem.findMany({
      where: {
        type: query.type,
        userId: query.userId,
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' } },
                { organization: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { [query.sortBy ?? 'createdAt']: query.order ?? 'desc' },
    });
  }

  listGenerations(query: ListGenerationsQueryDto) {
    return this.prisma.resumeGeneration.findMany({
      where: { userId: query.userId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { [query.sortBy ?? 'createdAt']: query.order ?? 'desc' },
    });
  }
}
