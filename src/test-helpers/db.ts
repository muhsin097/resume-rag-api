import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Plan } from '../generated/prisma/enums.js';

// Real DB connection for integration/concurrency tests -- these exist
// specifically to exercise genuine Postgres row-locking behavior under
// concurrent UPDATEs, which a mocked Prisma client can't demonstrate at
// all (a mock just returns whatever you tell it to, regardless of
// whether the real atomic guard actually holds). Points at whatever
// DATABASE_URL resolves to (the local dev Postgres via .env) -- never
// point this at a production URL.
export function createTestPrismaService(): PrismaService {
  const fakeConfigService = {
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (!value) throw new Error(`Missing env var ${key} for test -- is .env loaded?`);
      return value;
    },
  } as ConfigService;
  return new PrismaService(fakeConfigService);
}

export async function createTestUser(
  prisma: PrismaService,
  overrides: Partial<{ creditsBalance: number; creditsExpireAt: Date | null; plan: Plan }> = {},
) {
  return prisma.user.create({
    data: {
      email: `test-${randomUUID()}@example.invalid`,
      name: 'Test User',
      emailVerifiedAt: new Date(),
      creditsBalance: overrides.creditsBalance ?? 4,
      creditsExpireAt: overrides.creditsExpireAt ?? null,
      plan: overrides.plan ?? Plan.FREE,
    },
  });
}
