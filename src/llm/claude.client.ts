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
const GENERATION_TOOL_NAME = 'record_tailored_resume';

export interface MatchAnalysis {
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
}

export interface SkillClassification {
  keyword: string;
  approved: boolean;
  normalizedTitle: string;
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
        'You are an ATS (Applicant Tracking System) match analyzer. Compare a job description against a resume and call the record_match_analysis tool exactly once.',
      tools: [
        {
          name: ANALYSIS_TOOL_NAME,
          description:
            'Record the keyword match analysis between a job description and a resume',
          input_schema: {
            type: 'object',
            properties: {
              matchScore: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                description:
                  'Overall match score 0-100, based on how well the resume covers the important skills/qualifications/keywords the job description asks for.',
              },
              matchedKeywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Important skills/technologies/qualifications from the job description that the resume DOES reflect (directly or via a clear synonym). Each entry must be copied verbatim as it appears in the job description text, so it can be located by exact substring match.',
              },
              missingKeywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Important skills/technologies/qualifications the job description asks for that the resume does NOT reflect. Each entry must be copied verbatim as it appears in the job description text. Only include things that genuinely matter for the role -- not every noun in the posting.',
              },
            },
            required: ['matchScore', 'matchedKeywords', 'missingKeywords'],
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
      return { matchScore: 0, matchedKeywords: [], missingKeywords: [] };
    }

    const input = toolUseBlock.input as Partial<MatchAnalysis>;
    return {
      matchScore: input.matchScore ?? 0,
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
        'You decide whether a candidate may honestly add a requested keyword to their Skills list, given their real skills and experience. Approve a keyword only if it is a genuine, plausible extension of their real skill set -- a closely related technology, framework, tool, or a reasonable specialization of something they already have evidence of (e.g. they know Node.js and ask to add "Express.js" -- plausible). Reject anything unrelated to their actual background (e.g. a backend engineer asking to add "cooking" or "graphic design") or that isn\'t really a skill/technology at all. When in doubt, reject -- the candidate can always add it to their profile directly if it\'s genuinely true. Call the record_skill_classifications tool exactly once.',
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
