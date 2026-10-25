import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveGenerationCredit } from './resume-generations.service.js';
import { createTestPrismaService, createTestUser } from '../test-helpers/db.js';

// reserveGenerationCredit's atomicity guard (a single `updateMany WHERE
// creditsBalance >= amount`) is exactly what stops two concurrent
// requests from both reading a stale balance and both succeeding --
// classic check-then-act race. These tests fire real concurrent calls
// against real Postgres to prove the guard holds, plus cover the expiry
// branch (a positive balance that's past creditsExpireAt must still be
// rejected, not spent).
describe('reserveGenerationCredit concurrency/expiry', () => {
  const prisma = createTestPrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('never lets concurrent reservations overspend the balance', async () => {
    const user = await createTestUser(prisma, { creditsBalance: 4 });
    const COST = 2;
    const ATTEMPTS = 10;

    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () => reserveGenerationCredit(prisma, user.id, 'FREE', COST)),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value === true);
    const failed = results.filter((r) => r.status === 'rejected');
    // 4 balance / 2 cost -- exactly 2 of the 10 concurrent attempts can
    // possibly succeed, no matter how they're interleaved.
    expect(succeeded).toHaveLength(2);
    expect(failed).toHaveLength(ATTEMPTS - 2);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(0);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects reservation against an expired balance, even though creditsBalance is still positive', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const user = await createTestUser(prisma, { creditsBalance: 4, creditsExpireAt: pastDate });

    await expect(reserveGenerationCredit(prisma, user.id, 'FREE', 2)).rejects.toThrow(/expired/i);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(4); // rejected, not partially decremented

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('allows reservation when creditsExpireAt is in the future', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const user = await createTestUser(prisma, { creditsBalance: 4, creditsExpireAt: futureDate });

    const result = await reserveGenerationCredit(prisma, user.id, 'FREE', 2);
    expect(result).toBe(true);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(2);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects when balance is simply too low, with a different message than the expiry case', async () => {
    const user = await createTestUser(prisma, { creditsBalance: 1 });

    await expect(reserveGenerationCredit(prisma, user.id, 'FREE', 2)).rejects.toThrow(/not enough/i);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(1);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('PREMIUM plan bypasses the credit system entirely -- balance untouched, no reservation made', async () => {
    const user = await createTestUser(prisma, { creditsBalance: 0 });

    const result = await reserveGenerationCredit(prisma, user.id, 'PREMIUM', 2);
    expect(result).toBe(false);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(0);

    await prisma.user.delete({ where: { id: user.id } });
  });
});
