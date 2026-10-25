import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { createTestPrismaService, createTestUser } from '../test-helpers/db.js';

// This suite exists because JwtStrategy used to trust the JWT's embedded
// isAdmin claim and never checked deletedAt at all -- an admin demoted
// by hand in the DB, or an account soft-deleted via deleteAccount(),
// kept working at the OLD privilege level (or kept working at all) for
// up to 7 more days on an already-issued token. validate() now re-reads
// the live row every request; these tests prove that against a real
// Postgres row, not a mock that would just echo back whatever it's told.
describe('JwtStrategy.validate staleness checks', () => {
  const prisma = createTestPrismaService();
  const fakeConfigService = {
    getOrThrow: () => 'test-jwt-secret',
  } as unknown as ConfigService;
  const strategy = new JwtStrategy(fakeConfigService, prisma);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the live isAdmin value, not the stale claim embedded in the token', async () => {
    const user = await createTestUser(prisma);
    await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } });

    // Token claims isAdmin: false from whenever it was issued -- the
    // account was promoted to admin AFTER that, by hand, with no new
    // login. The live DB value should win.
    const result = await strategy.validate({
      sub: user.id,
      email: user.email,
      isAdmin: false,
      tokenVersion: 0,
    });
    expect(result.isAdmin).toBe(true);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects a token for an account that has since been soft-deleted', async () => {
    const user = await createTestUser(prisma);
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

    await expect(
      strategy.validate({ sub: user.id, email: user.email, isAdmin: false, tokenVersion: 0 }),
    ).rejects.toThrow(UnauthorizedException);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects a token issued before a password reset bumped tokenVersion', async () => {
    const user = await createTestUser(prisma);
    await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });

    // This token still carries tokenVersion: 0 from before the reset.
    await expect(
      strategy.validate({ sub: user.id, email: user.email, isAdmin: false, tokenVersion: 0 }),
    ).rejects.toThrow(UnauthorizedException);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('accepts a token whose tokenVersion still matches the live row', async () => {
    const user = await createTestUser(prisma);

    const result = await strategy.validate({
      sub: user.id,
      email: user.email,
      isAdmin: false,
      tokenVersion: 0,
    });
    expect(result.id).toBe(user.id);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('treats a missing tokenVersion claim as 0, for tokens issued before this field existed', async () => {
    const user = await createTestUser(prisma);

    const result = await strategy.validate({ sub: user.id, email: user.email, isAdmin: false });
    expect(result.id).toBe(user.id);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects a token for a user id that no longer exists at all', async () => {
    await expect(
      strategy.validate({
        sub: '00000000-0000-0000-0000-000000000000',
        email: 'gone@example.invalid',
        isAdmin: false,
        tokenVersion: 0,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
