import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ClaudeClient } from './claude.client.js';

// extractJobKeywords and classifyKeywordMatches used to return a fake
// success value (an empty keyword list, or fitScore: 0 with no matches)
// whenever Claude's response had no tool-use block at all -- stop_reason
// "max_tokens", a refusal, or any other malformed shape. That's
// indistinguishable from "Claude genuinely found nothing", and the
// fitScore: 0 especially got saved directly as a real candidate's score.
// These tests prove both now throw instead.
function fakeConfigService(): ConfigService {
  return { getOrThrow: () => 'test-api-key', get: () => undefined } as unknown as ConfigService;
}

function withMockedMessagesCreate(client: ClaudeClient, response: unknown) {
  const internal = client as unknown as { client: { messages: { create: unknown } } };
  internal.client.messages.create = vi.fn().mockResolvedValue(response);
}

describe('ClaudeClient keyword extraction/classification failure handling', () => {
  it('extractJobKeywords throws when the response has no tool-use block', async () => {
    const client = new ClaudeClient(fakeConfigService());
    withMockedMessagesCreate(client, { content: [], stop_reason: 'max_tokens' });

    await expect(client.extractJobKeywords('Some job description')).rejects.toThrow(
      /no record_job_keywords tool-use block/,
    );
  });

  it('extractJobKeywords returns the keywords on a well-formed response', async () => {
    const client = new ClaudeClient(fakeConfigService());
    withMockedMessagesCreate(client, {
      content: [{ type: 'tool_use', name: 'record_job_keywords', input: { keywords: ['TypeScript'] } }],
      stop_reason: 'tool_use',
    });

    await expect(client.extractJobKeywords('Some job description')).resolves.toEqual(['TypeScript']);
  });

  it('classifyKeywordMatches throws when the response has no tool-use block, instead of returning a fake fitScore: 0', async () => {
    const client = new ClaudeClient(fakeConfigService());
    withMockedMessagesCreate(client, { content: [], stop_reason: 'max_tokens' });

    await expect(
      client.classifyKeywordMatches({
        jobDescription: 'JD',
        keywords: ['TypeScript'],
        resumeContent: 'resume',
      }),
    ).rejects.toThrow(/no record_match_analysis tool-use block/);
  });

  it('classifyKeywordMatches returns the real classification on a well-formed response', async () => {
    const client = new ClaudeClient(fakeConfigService());
    withMockedMessagesCreate(client, {
      content: [
        {
          type: 'tool_use',
          name: 'record_match_analysis',
          input: { fitScore: 88, matchedKeywords: ['TypeScript'] },
        },
      ],
      stop_reason: 'tool_use',
    });

    await expect(
      client.classifyKeywordMatches({
        jobDescription: 'JD',
        keywords: ['TypeScript'],
        resumeContent: 'resume',
      }),
    ).resolves.toEqual({ fitScore: 88, matchedKeywords: ['TypeScript'] });
  });
});
