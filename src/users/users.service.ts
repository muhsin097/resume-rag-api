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
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findMe(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: PROFILE_SELECT,
    });
  }

  update(id: string, dto: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: PROFILE_SELECT,
    });
  }
}
