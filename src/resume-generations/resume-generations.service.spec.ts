import { describe, it, expect } from 'vitest';
import {
  keywordAppearsInResume,
  reconcileKeywordMatches,
  compareFactsByStartDateDesc,
  resolveFactItems,
  mergeExtraSkillTitles,
} from './resume-generations.service.js';
import type { ExperienceFact, MatchAnalysis } from '../llm/claude.client.js';

describe('mergeExtraSkillTitles', () => {
  it('accumulates across calls instead of replacing the previous list', () => {
    // This is the exact bug: a second addSkillsToGeneration call used to
    // rebuild the Skills section from profile skills + ONLY this call's
    // new resume-only titles, silently dropping whatever a prior call
    // had added since that list was never persisted anywhere.
    const afterFirstCall = mergeExtraSkillTitles([], ['Kubernetes']);
    expect(afterFirstCall).toEqual(['Kubernetes']);

    const afterSecondCall = mergeExtraSkillTitles(afterFirstCall, ['Docker']);
    expect(afterSecondCall).toEqual(['Kubernetes', 'Docker']);
  });

  it('dedupes case-insensitively against the existing list', () => {
    const result = mergeExtraSkillTitles(['Kubernetes'], ['kubernetes', 'Docker']);
    expect(result).toEqual(['Kubernetes', 'Docker']);
  });

  it('returns the existing list unchanged when nothing new is added', () => {
    expect(mergeExtraSkillTitles(['Kubernetes'], [])).toEqual(['Kubernetes']);
  });
});

describe('keywordAppearsInResume', () => {
  it('matches an exact substring', () => {
    expect(keywordAppearsInResume('TypeScript', 'Experienced in TypeScript and Node.js')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(keywordAppearsInResume('typescript', 'Experienced in TypeScript')).toBe(true);
  });

  it('treats "/", "-", and whitespace as interchangeable', () => {
    expect(keywordAppearsInResume('CI/CD', 'Set up CI-CD pipelines')).toBe(true);
    expect(keywordAppearsInResume('CI/CD', 'Set up CI CD pipelines')).toBe(true);
    expect(keywordAppearsInResume('Node.js', 'Built services in Node JS')).toBe(true);
  });

  it('does not false-positive a short keyword inside an unrelated word', () => {
    expect(keywordAppearsInResume('AI', 'Sent an email to the team')).toBe(false);
  });

  it('returns false for a keyword genuinely absent from the text', () => {
    expect(keywordAppearsInResume('Kubernetes', 'Experienced in TypeScript and Node.js')).toBe(false);
  });

  it('returns false for an empty keyword', () => {
    expect(keywordAppearsInResume('   ', 'anything')).toBe(false);
  });
});

describe('reconcileKeywordMatches', () => {
  it('reclassifies a "missing" keyword that is actually present in the resume text', () => {
    const analysis: MatchAnalysis = {
      fitScore: 80,
      matchedKeywords: ['React'],
      missingKeywords: ['TypeScript'],
    };
    const result = reconcileKeywordMatches(analysis, 'Experienced in React and TypeScript');
    expect(result.matchedKeywords).toEqual(['React', 'TypeScript']);
    expect(result.missingKeywords).toEqual([]);
    expect(result.keywordCoverage).toBe(100);
  });

  it('leaves a genuinely absent keyword in missingKeywords', () => {
    const analysis: MatchAnalysis = {
      fitScore: 50,
      matchedKeywords: ['React'],
      missingKeywords: ['Kubernetes'],
    };
    const result = reconcileKeywordMatches(analysis, 'Experienced in React only');
    expect(result.matchedKeywords).toEqual(['React']);
    expect(result.missingKeywords).toEqual(['Kubernetes']);
    expect(result.keywordCoverage).toBe(50);
  });

  it('falls back to fitScore for keywordCoverage when there are no keywords at all', () => {
    const analysis: MatchAnalysis = { fitScore: 73, matchedKeywords: [], missingKeywords: [] };
    const result = reconcileKeywordMatches(analysis, 'Some resume text');
    expect(result.keywordCoverage).toBe(73);
  });
});

describe('compareFactsByStartDateDesc', () => {
  it('sorts most recent startDate first', () => {
    const facts = [{ startDate: '2020-01-01' }, { startDate: '2023-01-01' }, { startDate: '2021-01-01' }];
    const sorted = [...facts].sort(compareFactsByStartDateDesc);
    expect(sorted.map((f) => f.startDate)).toEqual(['2023-01-01', '2021-01-01', '2020-01-01']);
  });

  it('sorts a fact with no startDate last', () => {
    const facts = [{ startDate: null }, { startDate: '2021-01-01' }];
    const sorted = [...facts].sort(compareFactsByStartDateDesc);
    expect(sorted.map((f) => f.startDate)).toEqual(['2021-01-01', null]);
  });

  it('treats two facts with no startDate as equal', () => {
    const facts = [{ startDate: null }, { startDate: null }];
    expect(() => [...facts].sort(compareFactsByStartDateDesc)).not.toThrow();
  });
});

describe('resolveFactItems', () => {
  function fact(id: string, type: ExperienceFact['type']): ExperienceFact {
    return { id, type, title: `Title ${id}`, content: `Content ${id}` };
  }

  it('resolves entries whose factId matches a fact of the expected type', () => {
    const facts = new Map([
      ['e1', fact('e1', 'EXPERIENCE')],
      ['p1', fact('p1', 'PROJECT')],
    ]);
    const result = resolveFactItems([{ factId: 'e1', bullets: ['did a thing'] }], facts, 'EXPERIENCE');
    expect(result).toHaveLength(1);
    expect(result[0].fact.id).toBe('e1');
  });

  it('drops an entry whose factId does not resolve to any known fact', () => {
    const facts = new Map([['e1', fact('e1', 'EXPERIENCE')]]);
    const result = resolveFactItems([{ factId: 'does-not-exist', bullets: ['x'] }], facts, 'EXPERIENCE');
    expect(result).toHaveLength(0);
  });

  it('drops an entry whose factId resolves to the wrong type', () => {
    // An ACHIEVEMENT factId showing up where an EXPERIENCE was expected --
    // e.g. Claude citing the wrong kind of fact for a section.
    const facts = new Map([['a1', fact('a1', 'ACHIEVEMENT')]]);
    const result = resolveFactItems([{ factId: 'a1', bullets: ['x'] }], facts, 'EXPERIENCE');
    expect(result).toHaveLength(0);
  });

  it('drops a repeated factId, keeping only the first occurrence', () => {
    const facts = new Map([['e1', fact('e1', 'EXPERIENCE')]]);
    const result = resolveFactItems(
      [
        { factId: 'e1', bullets: ['first bullet set'] },
        { factId: 'e1', bullets: ['duplicate bullet set'] },
      ],
      facts,
      'EXPERIENCE',
    );
    expect(result).toHaveLength(1);
    expect(result[0].bullets).toEqual(['first bullet set']);
  });
});
