import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveRankingCredit } from './recruiter-search.service.js';
import { createTestPrismaService, createTestRecruiter } from '../test-helpers/db.js';

// reserveRankingCredit's atomicity guard (a single `updateMany WHERE
// rankingCreditsUsed < limit`) is what stops two concurrent
// findBestFit searches from both reading the same stale count and both
// succeeding -- the exact same class of check-then-act race
// credit-reservation.concurrency.spec.ts already proves against for
// candidate credits. This fires real concurrent calls against real
// Postgres to prove the guard holds here too.
describe('reserveRankingCredit concurrency', () => {
  const prisma = createTestPrismaService();

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('never lets concurrent reservations exceed the limit', async () => {
    const recruiter = await createTestRecruiter(prisma);
    const LIMIT = 3;
    const ATTEMPTS = 10;

    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () => reserveRankingCredit(prisma, recruiter.id, LIMIT)),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    // Starts at 0 used, limit 3 -- exactly 3 of the 10 concurrent
    // attempts can possibly succeed, no matter how they're interleaved.
    expect(succeeded).toHaveLength(LIMIT);
    expect(failed).toHaveLength(ATTEMPTS - LIMIT);

    const updated = await prisma.recruiter.findUniqueOrThrow({ where: { id: recruiter.id } });
    expect(updated.rankingCreditsUsed).toBe(LIMIT);

    await prisma.recruiter.delete({ where: { id: recruiter.id } });
  });

  it('rejects once the limit is already reached', async () => {
    const recruiter = await createTestRecruiter(prisma);
    await prisma.recruiter.update({ where: { id: recruiter.id }, data: { rankingCreditsUsed: 3 } });

    await expect(reserveRankingCredit(prisma, recruiter.id, 3)).rejects.toThrow(/no ranking credits/i);

    const updated = await prisma.recruiter.findUniqueOrThrow({ where: { id: recruiter.id } });
    expect(updated.rankingCreditsUsed).toBe(3); // rejected, not incremented further

    await prisma.recruiter.delete({ where: { id: recruiter.id } });
  });
});
