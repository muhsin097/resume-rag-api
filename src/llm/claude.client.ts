import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatDateRange, type DatePrecision } from '../common/date-format.util.js';

export type { DatePrecision };

export interface ExperienceFact {
  title: string;
  organization?: string | null;
  content: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  startDatePrecision?: DatePrecision | null;
  endDatePrecision?: DatePrecision | null;
}

export const EXTRACTABLE_TYPES = [
  'EXPERIENCE',
  'EDUCATION',
  'CERTIFICATION',
  'PROJECT',
  'ACHIEVEMENT',
  'SKILL',
  'LANGUAGE',
] as const;

export interface ExtractedExperienceItem {
  type: (typeof EXTRACTABLE_TYPES)[number];
  title: string;
  organization?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  startDatePrecision?: DatePrecision | null;
  endDatePrecision?: DatePrecision | null;
}

export interface ExtractedContactInfo {
  phone?: string | null;
  location?: string | null;
  bio?: string | null;
}

export interface ExtractedResumeData {
  contactInfo: ExtractedContactInfo;
  items: ExtractedExperienceItem[];
}

const EXTRACTION_TOOL_NAME = 'record_experience_items';
const ANALYSIS_TOOL_NAME = 'record_match_analysis';
const SKILL_CLASSIFICATION_TOOL_NAME = 'record_skill_classifications';
const SKILL_CATEGORIZATION_TOOL_NAME = 'record_skill_categories';
const GENERATION_TOOL_NAME = 'record_tailored_resume';
const JOB_META_TOOL_NAME = 'record_job_meta';

export interface MatchAnalysis {
  // Claude's holistic judgment of overall candidate fit -- distinct from
  // keywordCoverage (computed deterministically in the service layer from
  // matchedKeywords/missingKeywords below, never an LLM guess).
  fitScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
}

export interface SkillClassification {
  keyword: string;
  approved: boolean;
  normalizedTitle: string;
}

export interface SkillCategoryAssignment {
  skill: string;
  category: string;
}

// Structured instead of a markdown blob specifically so it can be rendered
// as real headings/bullets on screen AND fed into docx/pdfkit for actual
// downloadable files -- regex-sniffing markdown back out of free text for
// either of those would be fragile.
export interface ResumeDocument {
  name: string;
  title: string | null;
  contactLine: string;
  summary: string | null;
  sections: {
    heading: string;
    items: {
      title: string;
      subtitle: string | null;
      bullets: string[];
    }[];
  }[];
}

// Education/Skills/Languages/Certifications never reach Claude at all --
// they're built deterministically in code (see deterministic-sections.ts)
// straight from the stored facts, since they never need JD-aware
// rewriting: a degree or a skill name doesn't change based on the job
// posting. Only Experience/Projects (JD-relevance-ranked) and Achievements
// (which benefit from the "fold into the right role" judgment call) go
// through the model. This is also why the old "don't drop a skill/degree"
// completeness rules are gone -- they're structurally impossible to
// violate now, since those facts never pass through the model to begin
// with.
const SYSTEM_PROMPT = `You are a resume-writing assistant.

You will be given a job description and a set of verified facts about a candidate's real Experience, Projects, and Achievements, retrieved from their profile. EXPERIENCE/PROJECT facts were chosen because they are the ones most semantically relevant to this job description; ACHIEVEMENT facts are the candidate's complete list.

Hard rules:
- Do NOT invent any experience, employer, or achievement that is not present in the provided facts. You are rephrasing and prioritizing real facts, not generating new ones.
- You MAY reword, reorder, and emphasize the real facts to better match the job description's own terminology and keywords (this is what makes the resume ATS-friendly).
- This resume must be a FRESH rewrite tailored to THIS job description, not a generic restatement. Pull specific keywords, technologies, and phrasing straight from the job description wherever a provided fact genuinely supports it, so two generations against two different job descriptions for the same candidate read differently -- in which facts are emphasized, which keywords surface in the bullets, and the summary's wording.
- The "title" is a short professional title (e.g. "Senior Backend Developer", "Full Stack Engineer") that appears directly under the candidate's name. Infer it from the candidate's real experience (their most senior/recent relevant role type), but angle the wording toward how this job description frames the role when the facts genuinely support it (e.g. "Backend Engineer" vs "Full Stack Developer" depending on which the candidate's real skills best match for this JD). Do not invent a title the candidate's experience doesn't support. Null only if there are no EXPERIENCE/PROJECT facts to infer one from.
- The "summary" is a short (max 2 sentences) professional summary, written fresh for this job description -- lead with the 2-4 of the candidate's real skills/technologies most relevant to this specific job description (the skills list itself is shown elsewhere -- you don't need to enumerate it here, just the ones worth highlighting for this JD). Do not pad or repeat the same summary across different job descriptions.
- Produce sections for "Experience" and "Projects" (only the ones the provided facts support), in that order, then "Achievements" last if any achievement facts don't get folded into a role (see below).
- One item per role/project, with a concise bolded title (e.g. "Senior Engineer at Acme Corp"), an optional subtitle, and the details as bullet points. Order items within each section in reverse chronological order (most recent/current first, using the date range given with each fact) -- the order facts were given to you is by JD relevance, NOT by date, so you must re-sort by date yourself rather than preserving that order. A fact with no date range given stays wherever it naturally fits.
- Subtitle dates: copy the exact "Mon YYYY – Mon YYYY" (or "Mon YYYY – Present") format given alongside each fact verbatim into that item's subtitle -- never reformat it as "YYYY-MM" or similar, that reads like a raw database value on a resume. If a fact's date only ever showed a year (no month given), use just the year (e.g. "2015 – 2019") -- do not invent a month/day that wasn't provided.
- Verb tense: use past tense ("Built", "Led", "Designed") for any role/project whose date range has already ended. Use present tense only for the one role with no end date (the current/ongoing position) -- never present tense for something that ended in the past, regardless of how recently.
- Achievements: if an ACHIEVEMENT fact clearly belongs to a specific role already covered in Experience (e.g. a metric from that job), fold it into that role's bullets instead of also listing it separately in an "Achievements" section -- never both. Only achievement facts that don't tie to a specific role go in a standalone "Achievements" section (single item, empty title/subtitle, one bullet per achievement), placed last.
- Be concise -- this should read as a tight 1-2 page resume, not a wall of text. 2-4 bullets per Experience/Project item is usually enough; don't restate the same point in different words to pad length.
- If the provided facts are thin for this particular job, say so plainly in a bullet rather than padding with invented content.
- Call the record_tailored_resume tool exactly once with the structured resume -- no commentary outside the tool call.`;

// Thin wrapper over the Anthropic SDK -- isolates the one place prompt
// construction happens, so the "never invent experience" constraint lives
// in exactly one spot rather than being re-derived at every call site.
@Injectable()
export class ClaudeClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(configService: ConfigService) {
    this.client = new Anthropic({
      apiKey: configService.getOrThrow<string>('ANTHROPIC_API_KEY'),
    });
    this.model =
      configService.get<string>('ANTHROPIC_MODEL') ??
      'claude-haiku-4-5-20251001';
  }

  async generateTailoredResume(params: {
    jobDescription: string;
    facts: ExperienceFact[];
    candidate: {
      name: string;
      email?: string | null;
      phone?: string | null;
      location?: string | null;
      bio?: string | null;
      linkedinUrl?: string | null;
      githubUrl?: string | null;
      websiteUrl?: string | null;
    };
  }): Promise<ResumeDocument> {
    const factsBlock = params.facts
      .map((fact, index) => {
        const header = fact.organization
          ? `${fact.title} at ${fact.organization}`
          : fact.title;
        const dateRange = formatDateRange(
          fact.startDate,
          fact.endDate,
          fact.startDatePrecision,
          fact.endDatePrecision,
        );
        const headerLine = dateRange ? `${header} (${dateRange})` : header;
        return `[Fact ${index + 1}] ${headerLine}\n${fact.content}`;
      })
      .join('\n\n');

    const contactLines = [
      params.candidate.name,
      params.candidate.location,
      params.candidate.phone,
      params.candidate.email,
      params.candidate.linkedinUrl,
      params.candidate.githubUrl,
      params.candidate.websiteUrl,
    ]
      .filter(Boolean)
      .join(' | ');
    const bioLine = params.candidate.bio
      ? `Candidate summary: ${params.candidate.bio}`
      : '';

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      // Deterministic on purpose: regenerating against unchanged facts and
      // JD should produce the same resume, not a reworded one. Without
      // this, the match score and keyword list could shift between
      // regenerations even with zero actual change to the candidate's
      // data -- the analyzeMatch call is deterministic given its input,
      // but that input (this resume's wording) wasn't, which showed up as
      // "I regenerated and the score got worse for no reason."
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: GENERATION_TOOL_NAME,
          description: 'Record the structured, tailored resume',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              title: {
                type: ['string', 'null'],
                description: 'Short professional title under the name, e.g. "Senior Backend Developer". Inferred from real experience, angled toward this job description where genuinely supported. Null only if there are no EXPERIENCE/PROJECT facts to infer one from.',
              },
              contactLine: {
                type: 'string',
                description: 'Pipe-separated contact details from the candidate contact header given to you -- location, phone, email, and any LinkedIn/GitHub/website links when given, e.g. "San Francisco, CA | 555-1234 | jane@example.com | linkedin.com/in/jane". Include every contact detail provided verbatim, in the order given -- don\'t drop the email or any link, don\'t reformat the links.',
              },
              summary: {
                type: ['string', 'null'],
                description: 'A fresh 1-2 sentence professional summary written specifically for THIS job description, leading with 2-4 of the candidate\'s real skills/technologies most relevant to it. Must vary between generations against different job descriptions. Null only if there are no facts to summarize.',
              },
              sections: {
                type: 'array',
                description: 'Use headings from this set, in this order, including only ones the facts support: "Experience", "Projects", "Achievements". Experience/Projects get one item per entry, bolded title + optional subtitle (dates) + bullets. "Achievements" (if any achievement facts didn\'t get folded into a role) gets exactly ONE item: empty string title, subtitle null, one bullet per leftover achievement.',
                items: {
                  type: 'object',
                  properties: {
                    heading: { type: 'string' },
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          title: { type: 'string', description: 'e.g. "Senior Engineer at Acme Corp" for Experience; for Skills/Languages/Achievements sections, an empty string ("") -- the section heading already labels it, do not repeat it here.' },
                          subtitle: { type: ['string', 'null'], description: 'e.g. dates. Null if not applicable.' },
                          bullets: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['title', 'subtitle', 'bullets'],
                      },
                    },
                  },
                  required: ['heading', 'items'],
                },
              },
            },
            required: ['name', 'title', 'contactLine', 'summary', 'sections'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: GENERATION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Job description:\n${params.jobDescription}\n\nCandidate contact header:\n${contactLines}\n${bioLine}\n\nCandidate's verified facts (most relevant first):\n${factsBlock}\n\nBuild a tailored resume using only the facts above.`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === GENERATION_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') {
      return { name: params.candidate.name, title: null, contactLine: contactLines, summary: null, sections: [] };
    }

    return toolUseBlock.input as ResumeDocument;
  }

  // Forced tool-use, same pattern as extraction -- compares the JD against
  // the resume that was just generated and scores how well they match.
  // Keywords are required to be verbatim substrings of the job description
  // text specifically so the frontend can highlight them by exact match.
  async analyzeMatch(params: {
    jobDescription: string;
    resumeContent: string;
  }): Promise<MatchAnalysis> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      // Deterministic on purpose: regenerating against the exact same JD
      // and resume should give the exact same score. At the default
      // temperature, the model picks a different subset of "important"
      // keywords each call, so the score swings run-to-run even with no
      // real change to the resume -- misleading as a before/after signal.
      temperature: 0,
      system:
        'You are an ATS (Applicant Tracking System) match analyzer. Compare a job description against a resume and call the record_match_analysis tool exactly once. Extract ONLY concrete, resume-checkable keywords: a specific skill, technology, tool, framework, certification, methodology, or short qualification like years of experience (roughly 1-4 words, a genuine noun phrase a candidate could literally put in a Skills list). If a requirement sentence lists several things (e.g. "8-10 years selling Microsoft solutions across the Microsoft portfolio"), split it into separate keywords ("8-10 years of experience", "Microsoft solutions", "Microsoft portfolio") rather than keeping it as one long phrase. Never extract a behavioral description, competency statement, or responsibility sentence, even a short one -- reject things like "operates with no supervision", "balances business objectives", "manages difficult and complex situations", "masters all phases of the software development lifecycle" -- these describe HOW someone works, not a checkable skill, and would look absurd added to a Skills list. Some job descriptions (especially competency-framework-style postings) are written almost entirely in this behavioral-prose style with few concrete skills mentioned -- when that happens, it is correct and expected to extract FEWER keywords overall. Do not force a behavioral sentence into a keyword just to have something to extract. Separately, also judge fitScore: your own holistic read of how well this candidate fits the role overall, using their FULL resume (seniority, depth of relevant experience, complementary skills, domain alignment) -- not a restatement of keyword coverage, which is computed elsewhere from your matched/missing lists. fitScore can legitimately sit above or below what pure keyword coverage would suggest. Give your genuine, precise assessment -- do not default to round numbers (ending in 0 or 5, or just below one like 92/82) out of habit; a fully honest assessment is just as likely to land on 77 or 88 as on 80 or 90.',
      tools: [
        {
          name: ANALYSIS_TOOL_NAME,
          description:
            'Record the keyword match analysis between a job description and a resume',
          input_schema: {
            type: 'object',
            properties: {
              fitScore: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                description:
                  "Your own holistic 0-100 judgment of how well this candidate fits the role overall -- weigh their full resume (seniority, depth of relevant experience, complementary/adjacent skills, domain alignment), not just literal keyword presence in the job description. This is deliberately separate from keyword coverage (computed elsewhere from matchedKeywords/missingKeywords) and can legitimately sit above or below it. Give a genuinely precise number -- avoid defaulting to round or 'safe-looking' values (e.g. 70/80/90, or 72/82/92) out of habit.",
              },
              matchedKeywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Concrete, resume-checkable skills/technologies/tools/certifications/qualifications (1-4 words each) from the job description that the resume DOES reflect (directly or via a clear synonym) -- one item per entry. NOT behavioral descriptions, competencies, or responsibility sentences (e.g. never "operates with no supervision" or "balances business objectives") -- only things a candidate could genuinely list on a resume. Each entry must be copied verbatim as it appears in the job description text, so it can be located by exact substring match.',
              },
              missingKeywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Concrete, resume-checkable skills/technologies/tools/certifications/qualifications (1-4 words each) the job description asks for that the resume does NOT reflect -- same granularity and same exclusions as matchedKeywords (no behavioral/competency phrases). Each entry must be copied verbatim as it appears in the job description text. Only include things that genuinely matter for the role -- not every noun in the posting. A posting written mostly in behavioral/competency prose may legitimately yield few or no entries here -- do not stretch a behavioral sentence into a fake keyword.',
              },
            },
            required: ['fitScore', 'matchedKeywords', 'missingKeywords'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: ANALYSIS_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Job description:\n${params.jobDescription}\n\nResume:\n${params.resumeContent}`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === ANALYSIS_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') {
      return { fitScore: 0, matchedKeywords: [], missingKeywords: [] };
    }

    const input = toolUseBlock.input as Partial<MatchAnalysis>;
    return {
      fitScore: input.fitScore ?? 0,
      matchedKeywords: input.matchedKeywords ?? [],
      missingKeywords: input.missingKeywords ?? [],
    };
  }

  // Lets a candidate request specific missing JD keywords be added to
  // their Skills list (the "+" button on a red/missing keyword). This is
  // a narrow classification call, NOT a resume generation -- it never
  // touches Experience/Summary, so there's no risk of a rejected or
  // approved keyword leaking into fabricated experience claims. Approved
  // keywords are spliced into the deterministic Skills list (and
  // optionally persisted as a real SKILL fact) by the caller; this method
  // only decides yes/no per keyword.
  async classifySkillKeywords(params: {
    keywords: string[];
    candidateSkills: string[];
    candidateExperienceSummary: string;
  }): Promise<SkillClassification[]> {
    if (params.keywords.length === 0) return [];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      // Deterministic on purpose: the same keyword against the same
      // profile should get the same approve/reject decision every time,
      // not flip on sampling noise.
      temperature: 0,
      system:
        'You decide whether a candidate may honestly add a requested keyword to their Skills list, given their real skills and experience. Infer their broad professional domain from their real skills/experience (e.g. software engineering, nursing, accounting) and APPROVE any requested keyword that is a genuine skill/technology/tool/methodology within that same broad domain -- it does not need to be a close specialization of something they already listed. A software engineer who knows Node.js and React asking to add "Kubernetes", "LLMs", "RAG", or "vector databases" is plausible even with zero prior AI/infra listed -- professionals routinely pick up adjacent tools and concepts in their own field, and the resume-tailoring context here (a software product) makes AI/ML tooling an especially normal adjacent area for any developer. REJECT only when: (a) the keyword is from a genuinely different, unrelated domain with no plausible connection to their field (e.g. a software engineer adding "cooking", "veterinary medicine", "truck driving"), or (b) it is not a real skill/technology/qualification at all (nonsense, a joke, random text). When genuinely torn between "same domain" and "unrelated", approve -- the bar is "would this be a dishonest claim," not "have they specifically proven this exact tool." Call the record_skill_classifications tool exactly once.',
      tools: [
        {
          name: SKILL_CLASSIFICATION_TOOL_NAME,
          description: 'Record yes/no for each requested keyword',
          input_schema: {
            type: 'object',
            properties: {
              classifications: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    keyword: { type: 'string', description: 'Exactly the keyword as given.' },
                    approved: { type: 'boolean' },
                    normalizedTitle: {
                      type: 'string',
                      description: 'Clean skill name to store if approved, e.g. "C++" not "c plus plus". Same as keyword if already clean.',
                    },
                  },
                  required: ['keyword', 'approved', 'normalizedTitle'],
                },
              },
            },
            required: ['classifications'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: SKILL_CLASSIFICATION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Candidate's real skills: ${params.candidateSkills.join(', ') || '(none listed)'}\n\nCandidate's experience summary: ${params.candidateExperienceSummary || '(none)'}\n\nRequested keywords to classify: ${params.keywords.join(', ')}`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === SKILL_CLASSIFICATION_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') return [];

    const input = toolUseBlock.input as { classifications?: SkillClassification[] };
    return input.classifications ?? [];
  }

  // Groups a candidate's skills into resume-style categories ("Languages &
  // Frameworks", "Cloud & DevOps", ...) -- called once per skill, when it's
  // first created (see ExperienceItemsService.createMany), with the result
  // persisted on the row. Every export/generation afterward just reads the
  // stored category, so this never runs on the free/no-Claude-call general
  // resume export path, and doesn't re-run on every tailored generation
  // either. Categories are inferred fresh from the given skill set each
  // time rather than drawn from a fixed list, so they fit whatever domain
  // the candidate is actually in (not forced into generic software-dev
  // buckets for a non-engineering profile).
  async categorizeSkills(skills: string[]): Promise<SkillCategoryAssignment[]> {
    if (skills.length === 0) return [];

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0,
      system:
        'You group a candidate\'s resume skills into a small number of broad, natural categories, the way a well-written resume\'s "Skills" section is organized -- not a precise taxonomy. For a software engineer\'s skills, a good grouping is close to: "Languages & Frameworks" (programming languages, frontend/backend/mobile frameworks), "Backend & Architecture" (architecture patterns, messaging, APIs), "Databases", "Cloud & DevOps" (cloud providers, containers, CI/CD, infra tools), "AI & LLM" (if applicable), "Testing & Quality", "Tools & Practices" (version control, methodologies, misc tools). Adapt this to the ACTUAL skills given and to the candidate\'s actual field (a non-engineering profile gets entirely different categories) -- but always merge aggressively: a HARD MAXIMUM of 6 categories, and never create a category for just one or two skills unless there is truly no sensible broader group for it (e.g. fold a single messaging tool like Kafka into "Backend & Architecture", fold "Agile" or version control into "Tools & Practices" rather than giving each its own category). Use short, title-cased category names (2-4 words). Every input skill must appear in exactly one assignment, copied verbatim. Call the record_skill_categories tool exactly once.',
      tools: [
        {
          name: SKILL_CATEGORIZATION_TOOL_NAME,
          description: 'Record a category for each given skill',
          input_schema: {
            type: 'object',
            properties: {
              assignments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    skill: { type: 'string', description: 'Exactly the skill as given.' },
                    category: { type: 'string', description: 'Short, title-cased category name, e.g. "Cloud & DevOps".' },
                  },
                  required: ['skill', 'category'],
                },
              },
            },
            required: ['assignments'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: SKILL_CATEGORIZATION_TOOL_NAME },
      messages: [{ role: 'user', content: `Skills to categorize: ${skills.join(', ')}` }],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === SKILL_CATEGORIZATION_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') return [];

    const input = toolUseBlock.input as { assignments?: SkillCategoryAssignment[] };
    return input.assignments ?? [];
  }

  // Small, cheap, deterministic extraction so History can show "Senior
  // Engineer at Acme" instead of a raw JD snippet. Only depends on the JD
  // text, so the caller runs this in parallel with retrieval/embedding
  // rather than after it.
  async extractJobMeta(
    jobDescription: string,
  ): Promise<{ jobTitle: string | null; companyName: string | null }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 200,
      temperature: 0,
      system:
        'Extract the job title and company name from this job posting, if clearly stated. Use null for either one that is not clearly present -- never guess or infer a company/title that is not explicitly written. Call the record_job_meta tool exactly once.',
      tools: [
        {
          name: JOB_META_TOOL_NAME,
          description: 'Record the job title and company name extracted from a job posting',
          input_schema: {
            type: 'object',
            properties: {
              jobTitle: {
                type: ['string', 'null'],
                description: 'The job title as stated in the posting, e.g. "Senior Backend Engineer". Null if not clearly stated.',
              },
              companyName: {
                type: ['string', 'null'],
                description: 'The hiring company\'s name as stated in the posting. Null if not clearly stated.',
              },
            },
            required: ['jobTitle', 'companyName'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: JOB_META_TOOL_NAME },
      messages: [{ role: 'user', content: jobDescription }],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === JOB_META_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') return { jobTitle: null, companyName: null };

    const input = toolUseBlock.input as { jobTitle?: string | null; companyName?: string | null };
    return { jobTitle: input.jobTitle ?? null, companyName: input.companyName ?? null };
  }

  // Forced tool-use rather than "please reply with JSON" -- the model has to
  // produce arguments matching the schema, which is far more reliable than
  // parsing JSON back out of a free-text reply.
  async extractExperienceItemsFromResume(
    resumeText: string,
  ): Promise<ExtractedResumeData> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system:
        'You extract structured data from resumes. Call the record_experience_items tool exactly once with the contact info/bio you can find, plus every distinct experience, education entry, certification, project, achievement, skill, and spoken/written language. For languages, use the LANGUAGE type with the title as "Language (Proficiency)" e.g. "Spanish (Fluent)" if a proficiency is stated, otherwise just the language name. Do not invent anything not present in the text -- this includes dates: always set startDatePrecision/endDatePrecision to match exactly what the source stated (a resume that just says "2015 – 2019" for a degree is YEAR precision, not a real January date).',
      tools: [
        {
          name: EXTRACTION_TOOL_NAME,
          description:
            'Record the structured contact info and experience items extracted from a resume',
          input_schema: {
            type: 'object',
            properties: {
              contactInfo: {
                type: 'object',
                description:
                  "The candidate's contact details and a short professional summary, if present in the resume.",
                properties: {
                  phone: { type: ['string', 'null'] },
                  location: {
                    type: ['string', 'null'],
                    description: 'City/region, e.g. "San Francisco, CA".',
                  },
                  bio: {
                    type: ['string', 'null'],
                    description:
                      "A short professional summary/headline (1-3 sentences), if the resume has one (e.g. a 'Summary' or 'About' section). Do not invent one if absent.",
                  },
                },
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: EXTRACTABLE_TYPES as unknown as string[],
                    },
                    title: { type: 'string' },
                    organization: { type: ['string', 'null'] },
                    description: { type: ['string', 'null'] },
                    startDate: {
                      type: ['string', 'null'],
                      description:
                        'ISO 8601 date (YYYY-MM-DD). If the source only gives a year or a month+year, fill in day=01 (and month=01 if only a year was given) so this is a valid date -- but set startDatePrecision accordingly so that placeholder day/month is never displayed as if it were real. Omit (null) if unknown.',
                    },
                    endDate: {
                      type: ['string', 'null'],
                      description:
                        'Same format and precision handling as startDate. Omit (null) if ongoing or unknown.',
                    },
                    startDatePrecision: {
                      type: ['string', 'null'],
                      enum: ['YEAR', 'MONTH', 'DAY', null],
                      description:
                        'How much of startDate the source actually stated: "YEAR" if only a year was given (e.g. "2015"), "MONTH" if a month+year was given (e.g. "Jan 2015"), "DAY" if a full date was given. Null if startDate is null.',
                    },
                    endDatePrecision: {
                      type: ['string', 'null'],
                      enum: ['YEAR', 'MONTH', 'DAY', null],
                      description: 'Same as startDatePrecision, for endDate.',
                    },
                  },
                  required: ['type', 'title'],
                },
              },
            },
            required: ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Resume text:\n\n${resumeText}`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === EXTRACTION_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') {
      return { contactInfo: {}, items: [] };
    }

    const input = toolUseBlock.input as {
      contactInfo?: ExtractedContactInfo;
      items?: ExtractedExperienceItem[];
    };
    return { contactInfo: input.contactInfo ?? {}, items: input.items ?? [] };
  }
}
