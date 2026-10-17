import { formatDateRange, formatByPrecision, type DatePrecision } from '../common/date-format.util.js';
import type { ResumeDocument } from '../llm/claude.client.js';

type Section = ResumeDocument['sections'][number];

interface CatalogFact {
  type: string;
  title: string;
  organization: string | null;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  startDatePrecision: DatePrecision | null;
  endDatePrecision: DatePrecision | null;
}

// Education/Certifications never need JD-aware rewriting -- a degree
// doesn't change based on the job posting -- so they're built directly
// from the stored facts rather than round-tripped through Claude. This
// also makes them immune to an entire category of generation bugs
// (dropped entries, invented dates, reworded titles) by construction,
// not by prompting the model harder not to do those things.
function buildEntrySection(
  heading: string,
  facts: CatalogFact[],
  // Certifications are a single "obtained on" date, not a range -- "Jun
  // 2022 – Present" reads like an ongoing job/degree, which a cert isn't.
  // Education legitimately can be a range ("Present" for still-enrolled).
  dateMode: 'range' | 'singleDate' = 'range',
): Section | null {
  if (facts.length === 0) return null;
  return {
    heading,
    items: facts.map((fact) => ({
      title: fact.organization ? `${fact.title} at ${fact.organization}` : fact.title,
      subtitle:
        dateMode === 'singleDate'
          ? fact.startDate
            ? formatByPrecision(fact.startDate, fact.startDatePrecision)
            : null
          : formatDateRange(
              fact.startDate,
              fact.endDate,
              fact.startDatePrecision,
              fact.endDatePrecision,
            ),
      bullets: fact.description
        ? fact.description.split('\n').map((line) => line.trim()).filter(Boolean)
        : [],
    })),
  };
}

// Skills get one JD-aware touch even though they're not rewritten by
// Claude: skills that literally appear in the job description text move
// to the front, so the most relevant ones aren't buried in a long list.
// Plain substring matching, not an LLM call -- deterministic and free.
//
// extraTitles: approved keywords from the "add missing keyword" flow that
// the candidate chose NOT to save permanently to their profile -- not a
// real stored fact, so not in `skills`, but still belongs in this one
// generation's Skills list. Always sorted first since they were
// specifically requested for this JD.
function buildSkillsSection(
  skills: CatalogFact[],
  jobDescription: string,
  extraTitles: string[] = [],
): Section | null {
  if (skills.length === 0 && extraTitles.length === 0) return null;
  const jdLower = jobDescription.toLowerCase();
  const sorted = [...skills].sort((a, b) => {
    const aMatch = jdLower.includes(a.title.toLowerCase()) ? 0 : 1;
    const bMatch = jdLower.includes(b.title.toLowerCase()) ? 0 : 1;
    return aMatch - bMatch;
  });
  return {
    heading: 'Skills',
    items: [
      { title: '', subtitle: null, bullets: [...extraTitles, ...sorted.map((s) => s.title)] },
    ],
  };
}

function buildFlatListSection(heading: string, facts: CatalogFact[]): Section | null {
  if (facts.length === 0) return null;
  return {
    heading,
    items: [{ title: '', subtitle: null, bullets: facts.map((f) => f.title) }],
  };
}

export function buildDeterministicSections(
  catalogItems: CatalogFact[],
  jobDescription: string,
  extraSkillTitles: string[] = [],
): { skills: Section | null; rest: Section[] } {
  const byType = (type: string) => catalogItems.filter((item) => item.type === type);

  return {
    skills: buildSkillsSection(byType('SKILL'), jobDescription, extraSkillTitles),
    rest: [
      buildEntrySection('Education', byType('EDUCATION')),
      buildFlatListSection('Languages', byType('LANGUAGE')),
      buildEntrySection('Certifications', byType('CERTIFICATION'), 'singleDate'),
    ].filter((s): s is Section => s !== null),
  };
}
