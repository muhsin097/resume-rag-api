import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

const PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  location: true,
  bio: true,
  linkedinUrl: true,
  githubUrl: true,
  websiteUrl: true,
  jobSearchEnabled: true,
  plan: true,
  freeGenerationsUsed: true,
  creditsBalance: true,
  creditsExpireAt: true,
  createdAt: true,
} as const;

// Credits past their expiry are rejected at spend time (see
// reserveGenerationCredit), but the raw DB row isn't zeroed out lazily --
// without this, the badge/dashboard would keep showing a stale "5 credits"
// that then fails with "expired" the moment the user actually tries to
// spend one, which reads as a bug even though it's working as designed.
function withEffectiveCredits<T extends { creditsBalance: number; creditsExpireAt: Date | null }>(
  user: T,
): T {
  const expired = user.creditsExpireAt !== null && user.creditsExpireAt <= new Date();
  return expired ? { ...user, creditsBalance: 0 } : user;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findMe(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: PROFILE_SELECT,
    });
    return withEffectiveCredits(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.update({
      where: { id },
      data: dto,
      select: PROFILE_SELECT,
    });
    return withEffectiveCredits(user);
  }

  // Soft delete, not a row removal -- email and freeGenerationsUsed are
  // deliberately kept (see the `deletedAt` field comment in schema.prisma)
  // so this can't be used to farm a fresh free-generation allowance by
  // deleting and re-registering. Profile content (experience items, past
  // generations) and other personal fields are genuinely removed/cleared;
  // login is blocked by clearing passwordHash, same as an OAuth-only
  // account that never set one.
  async deleteAccount(id: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.experienceItem.deleteMany({ where: { userId: id } }),
      this.prisma.resumeGeneration.deleteMany({ where: { userId: id } }),
      this.prisma.user.update({
        where: { id },
        data: {
          name: 'Deleted User',
          passwordHash: null,
          phone: null,
          location: null,
          bio: null,
          linkedinUrl: null,
          githubUrl: null,
          websiteUrl: null,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          emailVerificationCodeHash: null,
          emailVerificationExpiresAt: null,
          deletedAt: new Date(),
        },
      }),
    ]);
  }
}
