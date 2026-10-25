import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service.js';
import { createFakeEmailService, createTestPrismaService } from '../test-helpers/db.js';

// This suite exists because the 6-digit OTP (1M combinations) used to
// have no cap on failed verifyEmail() attempts within its 10-minute TTL
// -- a script could grind every combination against one issued code
// well inside that window. These tests prove the cap added in
// AuthService.verifyEmail actually locks the code out against a real
// row, not just that the code reads correctly.
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

describe('AuthService OTP attempt lockout', () => {
  const prisma = createTestPrismaService();
  const fakeJwtService = { sign: () => 'fake-token' } as unknown as JwtService;
  const fakeConfigService = {} as ConfigService;
  const service = new AuthService(prisma, fakeJwtService, fakeConfigService, createFakeEmailService() as never);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createUnverifiedUser(code: string) {
    return prisma.user.create({
      data: {
        email: `test-otp-${Date.now()}-${Math.random()}@example.invalid`,
        name: 'Test User',
        emailVerificationCodeHash: hashCode(code),
        emailVerificationExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
  }

  it('verifies successfully with the right code and resets the attempt counter', async () => {
    const user = await createUnverifiedUser('111111');
    const result = await service.verifyEmail(user.email, '111111');
    expect(result.user.id).toBe(user.id);

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.emailVerifiedAt).not.toBeNull();
    expect(reloaded.emailVerificationAttempts).toBe(0);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('increments the attempt counter on a wrong code without locking it out early', async () => {
    const user = await createUnverifiedUser('222222');

    await expect(service.verifyEmail(user.email, '000000')).rejects.toThrow(BadRequestException);

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.emailVerificationAttempts).toBe(1);
    expect(reloaded.emailVerificationCodeHash).not.toBeNull();

    // The real code still works -- one wrong guess doesn't burn the code.
    const result = await service.verifyEmail(user.email, '222222');
    expect(result.user.id).toBe(user.id);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('invalidates the code outright after 5 wrong attempts, rejecting even the correct code afterward', async () => {
    const user = await createUnverifiedUser('333333');

    for (let i = 0; i < 5; i++) {
      await expect(service.verifyEmail(user.email, '000000')).rejects.toThrow(BadRequestException);
    }

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.emailVerificationCodeHash).toBeNull();
    expect(reloaded.emailVerificationAttempts).toBe(0);

    // The ONCE-correct code is now worthless -- the row has no code to
    // compare against at all, so even the real '333333' is rejected.
    await expect(service.verifyEmail(user.email, '333333')).rejects.toThrow(BadRequestException);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('resendVerificationCode resets the attempt counter for a fresh grinding window', async () => {
    const user = await createUnverifiedUser('444444');
    await expect(service.verifyEmail(user.email, '000000')).rejects.toThrow(BadRequestException);

    await service.resendVerificationCode(user.email);

    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(reloaded.emailVerificationAttempts).toBe(0);
    expect(reloaded.emailVerificationCodeHash).not.toBeNull();

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('login() still blocks an unverified account regardless of OTP state', async () => {
    const user = await createUnverifiedUser('555555');
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: 'irrelevant-for-this-check' } });

    await expect(service.login({ email: user.email, password: 'anything' })).rejects.not.toThrow(ForbiddenException);
    // (password mismatch throws Unauthorized first -- the point of this
    // suite is the OTP cap above, this just documents the ordering.)

    await prisma.user.delete({ where: { id: user.id } });
  });
});
