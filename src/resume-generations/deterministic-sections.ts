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
  // Only ever set for type SKILL -- see ExperienceItem.category in the
  // Prisma schema for how/when this gets assigned.
  category?: string | null;
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
// Grouped into categories (one item per category, title = category name)
// rather than one flat comma-separated line -- category is assigned once,
// when a skill is first created (see ExperienceItemsService), not here, so
// this stays a pure/sync function with no Claude call of its own. A group's
// position is its first (JD-match-sorted) skill's position, so categories
// containing JD-relevant skills still surface first. Uncategorized skills
// (briefly, between creation and classification, or if that call ever
// failed) fall into an unlabeled trailing bucket rather than being dropped.
//
// extraTitles: approved keywords from the "add missing keyword" flow that
// the candidate chose NOT to save permanently to their profile -- not a
// real stored fact, so no category to group by. Always an unlabeled,
// leading item, since they were specifically requested for this JD.
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

  const groups = new Map<string, string[]>();
  for (const skill of sorted) {
    const category = skill.category?.trim() || '';
    const bucket = groups.get(category);
    if (bucket) bucket.push(skill.title);
    else groups.set(category, [skill.title]);
  }

  // Uncategorized skills (no category yet, or the classification call
  // failed/never ran for them) are pulled out and rendered last rather
  // than wherever they happen to fall in DB fetch order -- categorized
  // groups first, any leftovers trailing at the bottom.
  const uncategorized = groups.get('');
  groups.delete('');

  const items: Section['items'] = [];
  if (extraTitles.length > 0) {
    items.push({ title: '', subtitle: null, bullets: extraTitles });
  }
  for (const [category, titles] of groups) {
    items.push({ title: category, subtitle: null, bullets: titles });
  }
  if (uncategorized) {
    items.push({ title: '', subtitle: null, bullets: uncategorized });
  }

  return { heading: 'Skills', items };
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

// The "download a general resume" path on the Profile page -- every
// catalog item, verbatim, with no JD and no Claude call at all. Unlike a
// tailored generation (which only sends Claude a JD-relevant subset of
// Experience/Projects), this includes everything the candidate has on
// file; tailoring down to what's relevant to a specific role is the paid,
// JD-aware flow this deliberately isn't.
export function buildGeneralResumeSections(catalogItems: CatalogFact[]): Section[] {
  const byType = (type: string) => catalogItems.filter((item) => item.type === type);

  return [
    buildSkillsSection(byType('SKILL'), ''),
    buildEntrySection('Experience', byType('EXPERIENCE')),
    buildEntrySection('Projects', byType('PROJECT')),
    buildEntrySection('Education', byType('EDUCATION')),
    buildFlatListSection('Languages', byType('LANGUAGE')),
    buildEntrySection('Certifications', byType('CERTIFICATION'), 'singleDate'),
    buildEntrySection('Achievements', byType('ACHIEVEMENT')),
  ].filter((s): s is Section => s !== null);
}

// title/summary have no JD to angle toward here, so they fall back to
// plain facts rather than anything inferred: the candidate's own bio as
// the summary, and their most recent job title (first EXPERIENCE item,
// relying on the caller's items already being startDate-desc ordered)
// as a reasonable generic headline.
export function buildGeneralResumeDocument(
  user: {
    name: string;
    email: string;
    phone: string | null;
    location: string | null;
    bio: string | null;
    linkedinUrl: string | null;
    githubUrl: string | null;
    websiteUrl: string | null;
  },
  catalogItems: CatalogFact[],
): ResumeDocument {
  const contactLine = [
    user.location,
    user.phone,
    user.email,
    user.linkedinUrl,
    user.githubUrl,
    user.websiteUrl,
  ]
    .filter(Boolean)
    .join(' | ');

  const mostRecentExperience = catalogItems.find((item) => item.type === 'EXPERIENCE');

  return {
    name: user.name,
    title: mostRecentExperience?.title ?? null,
    contactLine,
    summary: user.bio,
    sections: buildGeneralResumeSections(catalogItems),
  };
}
