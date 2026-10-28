import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ClaudeClient } from '../llm/claude.client.js';
import { VectorService } from '../vector/vector.service.js';
import { ExperienceItemsService } from './experience-items.service.js';
import { createTestPrismaService, createTestUser } from '../test-helpers/db.js';
import { ExperienceType } from '../generated/prisma/enums.js';

// create()/createMany()/update() used to write the ExperienceItem row
// FIRST and only call Voyage afterward -- a failed embed (rate limit,
// network blip, Voyage outage) left the row committed with no embedding
// at all, invisible to RAG retrieval, with no error anywhere and no way
// to repair it (a retry just hit findDuplicate's ConflictException
// against the orphan itself). These tests fire a real failing Voyage
// call against a real Postgres connection to prove the fix: either
// nothing is written at all, or (for update) the existing row is left
// completely untouched.
function fakeConfigService(): ConfigService {
  return { get: () => undefined, getOrThrow: () => 'irrelevant' } as unknown as ConfigService;
}

function failingVoyageClient() {
  return {
    embed: async () => {
      throw new Error('Voyage is down');
    },
    embedMany: async () => {
      throw new Error('Voyage is down');
    },
  };
}

describe('No orphaned embeddings when the embed call fails', () => {
  const prisma = createTestPrismaService();
  const failingVectorService = new VectorService(
    prisma,
    failingVoyageClient() as never,
    fakeConfigService(),
  );
  const fakeClaudeClient = {} as ClaudeClient; // SKILL type never used below, so never invoked
  const service = new ExperienceItemsService(prisma, failingVectorService, fakeClaudeClient);

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('create() leaves no ExperienceItem row behind when the embed call fails', async () => {
    const user = await createTestUser(prisma);

    await expect(
      service.create(user.id, { type: ExperienceType.PROJECT, title: 'Orphan Test Project' }),
    ).rejects.toThrow('Voyage is down');

    const rows = await prisma.experienceItem.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('createMany() leaves no ExperienceItem rows behind when the batch embed call fails', async () => {
    const user = await createTestUser(prisma);

    await expect(
      service.createMany(user.id, [
        { type: ExperienceType.PROJECT, title: 'Orphan Batch A' },
        { type: ExperienceType.PROJECT, title: 'Orphan Batch B' },
      ]),
    ).rejects.toThrow('Voyage is down');

    const rows = await prisma.experienceItem.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('update() leaves the existing row and its content completely untouched when the embed call fails', async () => {
    const user = await createTestUser(prisma);
    const original = await prisma.experienceItem.create({
      data: {
        userId: user.id,
        type: ExperienceType.PROJECT,
        title: 'Untouched Project',
        content: 'Untouched Project',
      },
    });

    await expect(
      service.update(user.id, original.id, { description: 'A new description' }),
    ).rejects.toThrow('Voyage is down');

    const reloaded = await prisma.experienceItem.findUniqueOrThrow({ where: { id: original.id } });
    expect(reloaded.description).toBeNull();
    expect(reloaded.content).toBe('Untouched Project');

    await prisma.user.delete({ where: { id: user.id } });
  });
});
