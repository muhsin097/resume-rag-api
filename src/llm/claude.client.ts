import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatDateRange, type DatePrecision } from '../common/date-format.util.js';

export type { DatePrecision };

export interface ExperienceFact {
  // Real database id -- Claude is required to cite this back per item
  // (see GeneratedResumeContent below) so the service layer can validate
  // every returned item actually traces to a fact this user owns, rather
  // than trusting generated title/employer/dates at face value.
  id: string;
  type: 'EXPERIENCE' | 'PROJECT' | 'ACHIEVEMENT';
  title: string;
  organization?: string | null;
  content: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  startDatePrecision?: DatePrecision | null;
  endDatePrecision?: DatePrecision | null;
  // See ExperienceItem.isCurrent in the Prisma schema. Passed through so
  // the verb-tense instruction below has a reliable signal instead of
  // inferring "ongoing" from endDate being absent.
  isCurrent?: boolean;
}

// What Claude actually contributes to a tailored resume: bullet prose per
// fact, plus the two genuinely interpretive fields (title, summary). Name,
// contact details, employer names, role titles, and dates are deliberately
// NOT part of this -- those are assembled in code from the real
// ExperienceFact rows (see ResumeGenerationsService), the same way
// Education/Certifications already work in deterministic-sections.ts.
// Every bullets entry is tied to a real factId, validated against the
// facts actually given to this call before being trusted.
export interface GeneratedResumeContent {
  title: string | null;
  summary: string | null;
  experienceItems: { factId: string; bullets: string[] }[];
  projectItems: { factId: string; bullets: string[] }[];
  // Only ACHIEVEMENT facts that didn't get folded into a specific
  // experience/project item's bullets above.
  achievements: { factId: string; bullet: string }[];
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
  isCurrent?: boolean;
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
const JOB_KEYWORDS_TOOL_NAME = 'record_job_keywords';
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
// posting. Experience/Projects/Achievements DO reach the model (bullet
// prose benefits from JD-aware rewriting), but even there, only the
// bullets are Claude's to write -- employer, role title, and dates are
// assembled in code from the same fact rows afterward (see
// ResumeGenerationsService), identified by the factId Claude cites back.
// This is why the old "don't invent an employer/date" rules below are
// about bullet CONTENT, not structure -- the structure is no longer the
// model's to get right or wrong.
const SYSTEM_PROMPT = `You are a resume-writing assistant.

You will be given a job description and a set of verified facts about a candidate's real Experience, Projects, and Achievements, retrieved from their profile, each tagged with an id and a type (EXPERIENCE, PROJECT, or ACHIEVEMENT). EXPERIENCE/PROJECT facts were chosen because they are the ones most semantically relevant to this job description; ACHIEVEMENT facts are the candidate's complete list.

Hard rules:
- Do NOT invent any experience, employer, skill, or achievement that is not present in the provided facts. You are rephrasing a given fact's own content into bullet points, not generating new claims.
- You MAY reword and emphasize a fact's content to match the job description's own terminology and keywords (this is what makes the resume ATS-friendly) -- but every bullet under a given factId must come from THAT fact's content, not borrowed from a different fact.
- This resume must be a FRESH rewrite tailored to THIS job description, not a generic restatement. Pull specific keywords, technologies, and phrasing straight from the job description wherever a fact genuinely supports it, so two generations against two different job descriptions for the same candidate read differently -- in which bullets are emphasized, which keywords surface, and the summary's wording.
- For EVERY fact tagged type=EXPERIENCE, add exactly one entry to experienceItems with that fact's id as factId and 2-4 rewritten bullets. For EVERY fact tagged type=PROJECT, same, but into projectItems. Never skip one to save space or "stay concise" -- if the full set is large, write fewer/shorter bullets per item, not fewer items. A candidate with 8 relevant projects should see all 8.
- For each ACHIEVEMENT fact: if its content clearly belongs to a specific EXPERIENCE fact already covered (e.g. a metric from that job), fold a bullet derived from it into that EXPERIENCE fact's bullets array instead (do not also add it to achievements). Only achievement facts that don't tie to a specific role go into achievements, one entry per fact with that fact's id as factId.
- The "title" is a short professional title (e.g. "Senior Backend Developer", "Full Stack Engineer") that appears directly under the candidate's name. Infer it from the real EXPERIENCE/PROJECT facts (most senior/recent relevant role type), angled toward how this job description frames the role when genuinely supported. Null only if there are no EXPERIENCE/PROJECT facts to infer one from.
- The "summary" is a short (max 2 sentences) professional summary, written fresh for this job description -- lead with 2-4 of the candidate's real skills/technologies most relevant to it (the skills list itself is shown elsewhere -- don't enumerate it here). Do not pad or repeat the same summary across different job descriptions.
- Verb tense: use past tense ("Built", "Led", "Designed") for any fact that isn't current. Use present tense only for a fact explicitly marked as current/ongoing -- never present tense for something that's ended, regardless of how recently.
- Be concise at the bullet level -- this should read as a tight 1-2 page resume, not a wall of text. 2-4 bullets per item is usually enough; don't restate the same point in different words to pad length.
- If the provided facts are thin for this particular job, say so plainly in a bullet rather than padding with invented content.
- Call the record_tailored_resume tool exactly once -- no commentary outside the tool call.`;

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
      // The SDK's own default is 10 minutes -- fine for a batch script,
      // but every call here sits inline in a user-facing HTTP request (a
      // candidate watching the "Generating..." spinner, or a request
      // thread tied up on this box's 1GB instance). 60s comfortably
      // covers even the largest call (extractExperienceItemsFromResume,
      // max_tokens 4000) while still failing fast enough that the
      // frontend's own request timeout/error state kicks in reasonably.
      timeout: 60_000,
    });
    this.model =
      configService.get<string>('ANTHROPIC_MODEL') ??
      'claude-haiku-4-5-20251001';
  }

  async generateTailoredResume(params: {
    jobDescription: string;
    facts: ExperienceFact[];
    // Not contact info -- qualitative self-description, genuinely useful
    // context for writing the summary/title. Name/email/phone/location/
    // links never reach this call at all; those are assembled in code
    // from the real user row (see ResumeGenerationsService).
    bio?: string | null;
  }): Promise<GeneratedResumeContent> {
    const factsBlock = params.facts
      .map((fact) => {
        const header = fact.organization
          ? `${fact.title} at ${fact.organization}`
          : fact.title;
        const dateRange = formatDateRange(
          fact.startDate,
          fact.endDate,
          fact.startDatePrecision,
          fact.endDatePrecision,
          fact.isCurrent,
        );
        const headerLine = dateRange ? `${header} (${dateRange})` : header;
        return `[Fact id=${fact.id} type=${fact.type}] ${headerLine}\n${fact.content}`;
      })
      .join('\n\n');

    const bioLine = params.bio ? `Candidate summary: ${params.bio}` : '';

    const response = await this.client.messages.create({
      model: this.model,
      // Up to 8 Experience + 8 Project facts can be fed in (RANKED_TOP_K),
      // each wanting 2-4 bullets -- 2000 was tight enough that Claude
      // would truncate mid-resume, quietly dropping entries rather than
      // erroring. 4000 matches the budget already used for
      // extractExperienceItemsFromResume, which handles similarly-sized
      // content.
      max_tokens: 4000,
      // temperature: 0 minimizes run-to-run variance -- NOT a guarantee of
      // byte-identical output (serving-side batching/floating-point
      // effects can still shift a token here and there) or of factual
      // correctness. The point of setting it here is narrower: without
      // it, regenerating against unchanged facts and an unchanged JD could
      // reword the resume enough that the match score and keyword list
      // visibly shifted too, which showed up as "I regenerated and the
      // score got worse for no reason."
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: GENERATION_TOOL_NAME,
          description: 'Record the bullet content for a tailored resume',
          input_schema: {
            type: 'object',
            properties: {
              title: {
                type: ['string', 'null'],
                description: 'Short professional title under the name, e.g. "Senior Backend Developer". Inferred from real EXPERIENCE/PROJECT facts, angled toward this job description where genuinely supported. Null only if there are no EXPERIENCE/PROJECT facts to infer one from.',
              },
              summary: {
                type: ['string', 'null'],
                description: 'A fresh 1-2 sentence professional summary written specifically for THIS job description, leading with 2-4 of the candidate\'s real skills/technologies most relevant to it. Must vary between generations against different job descriptions. Null only if there are no facts to summarize.',
              },
              experienceItems: {
                type: 'array',
                description: 'Exactly one entry per fact tagged type=EXPERIENCE -- never fewer.',
                items: {
                  type: 'object',
                  properties: {
                    factId: { type: 'string', description: 'Copy verbatim from that fact\'s "[Fact id=... type=EXPERIENCE]" tag.' },
                    bullets: { type: 'array', items: { type: 'string' }, description: '2-4 bullets rewritten from this fact\'s own content only.' },
                  },
                  required: ['factId', 'bullets'],
                },
              },
              projectItems: {
                type: 'array',
                description: 'Exactly one entry per fact tagged type=PROJECT -- never fewer. Same shape as experienceItems.',
                items: {
                  type: 'object',
                  properties: {
                    factId: { type: 'string', description: 'Copy verbatim from that fact\'s "[Fact id=... type=PROJECT]" tag.' },
                    bullets: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['factId', 'bullets'],
                },
              },
              achievements: {
                type: 'array',
                description: 'One entry per ACHIEVEMENT fact that did NOT get folded into an experienceItems bullet. Omit any achievement fact you folded in instead.',
                items: {
                  type: 'object',
                  properties: {
                    factId: { type: 'string', description: 'Copy verbatim from that fact\'s "[Fact id=... type=ACHIEVEMENT]" tag.' },
                    bullet: { type: 'string' },
                  },
                  required: ['factId', 'bullet'],
                },
              },
            },
            required: ['title', 'summary', 'experienceItems', 'projectItems', 'achievements'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: GENERATION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Job description:\n${params.jobDescription}\n${bioLine}\n\nCandidate's verified facts (most relevant first):\n${factsBlock}\n\nWrite bullet content using only the facts above.`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === GENERATION_TOOL_NAME,
    );
    // Previously returned a fake-empty success object here (null title/
    // summary, empty arrays) -- the service layer had no way to tell
    // "Claude genuinely had nothing to say" apart from "the response was
    // malformed," so a malformed response was silently saved as a
    // near-blank resume AND kept the credit already charged for it.
    // Throwing routes this into the existing reserveGenerationCredit
    // catch-and-refund path instead.
    if (toolUseBlock?.type !== 'tool_use') {
      throw new Error(
        `generateTailoredResume: no ${GENERATION_TOOL_NAME} tool-use block in Claude's response (stop_reason: ${response.stop_reason})`,
      );
    }

    return toolUseBlock.input as GeneratedResumeContent;
  }

  // Split from the old combined analyzeMatch into two steps specifically
  // so the "which keywords matter" list can be cached per-JD (see
  // ResumeGenerationsService.getOrExtractJobKeywords) and reused across
  // every generate/rescore against that same posting. Previously, the
  // keyword list was re-derived from scratch on every single call --
  // temperature:0 reduces but doesn't eliminate run-to-run variance in a
  // judgment call like "how finely to split a compound requirement," so
  // regenerating against an unchanged JD and an unchanged resume could
  // still show a visibly different "missing keywords" list, which read
  // as a confusing, unexplained score swing. This method is the
  // extraction half only -- no resume involved at all, independent of
  // any candidate.
  async extractJobKeywords(jobDescription: string): Promise<string[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0,
      system:
        'Extract concrete, resume-checkable keywords from a job description and call the record_job_keywords tool exactly once. Extract ONLY concrete, resume-checkable keywords: a specific skill, technology, tool, framework, certification, methodology, or short qualification like years of experience (roughly 1-4 words, a genuine noun phrase a candidate could literally put in a Skills list). If a requirement sentence lists several things (e.g. "8-10 years selling Microsoft solutions across the Microsoft portfolio"), split it into separate keywords ("8-10 years of experience", "Microsoft solutions", "Microsoft portfolio") rather than keeping it as one long phrase. Never extract a behavioral description, competency statement, or responsibility sentence, even a short one -- reject things like "operates with no supervision", "balances business objectives", "manages difficult and complex situations", "masters all phases of the software development lifecycle" -- these describe HOW someone works, not a checkable skill, and would look absurd added to a Skills list. Some job descriptions (especially competency-framework-style postings) are written almost entirely in this behavioral-prose style with few concrete skills mentioned -- when that happens, it is correct and expected to extract FEWER keywords overall. Do not force a behavioral sentence into a keyword just to have something to extract.',
      tools: [
        {
          name: JOB_KEYWORDS_TOOL_NAME,
          description: 'Record the extracted keyword list for a job description',
          input_schema: {
            type: 'object',
            properties: {
              keywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Concrete, resume-checkable skills/technologies/tools/certifications/qualifications (1-4 words each) from the job description. Only things that genuinely matter for the role -- not every noun in the posting. Each entry must be copied verbatim as it appears in the job description text, so it can be located by exact substring match. A posting written mostly in behavioral/competency prose may legitimately yield few or no entries -- do not stretch a behavioral sentence into a fake keyword.',
              },
            },
            required: ['keywords'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: JOB_KEYWORDS_TOOL_NAME },
      messages: [{ role: 'user', content: `Job description:\n${jobDescription}` }],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === JOB_KEYWORDS_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') return [];
    const input = toolUseBlock.input as { keywords?: string[] };
    return input.keywords ?? [];
  }

  // The classification half -- given a FIXED keyword list (from
  // extractJobKeywords, cached), decides which of THOSE keywords the
  // resume reflects. Deliberately returns only matchedKeywords, not a
  // separately-generated missingKeywords -- the caller derives missing as
  // the complement of the given keyword list, which guarantees every
  // generation's missing list is always exactly "the stable keyword list
  // minus whatever matched this specific resume," never a keyword Claude
  // invented or silently dropped from either list.
  async classifyKeywordMatches(params: {
    jobDescription: string;
    keywords: string[];
    resumeContent: string;
  }): Promise<{ fitScore: number; matchedKeywords: string[] }> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      // temperature: 0 minimizes run-to-run variance, not a guarantee of
      // an identical or factually-correct score every time.
      temperature: 0,
      system:
        'You are an ATS (Applicant Tracking System) match analyzer. Call the record_match_analysis tool exactly once. You are given a fixed list of keywords already extracted from the job description -- decide which of THOSE EXACT keywords (copy verbatim from the given list) the resume reflects, directly or via a clear synonym. Do not invent new keywords and do not omit any decision -- every keyword in the given list is either reflected by the resume or it is not. Separately, also judge fitScore: your own holistic read of how well this candidate fits the role overall, using their FULL resume (seniority, depth of relevant experience, complementary skills, domain alignment) -- not a restatement of keyword coverage, which is computed elsewhere from the matched list. fitScore can legitimately sit above or below what pure keyword coverage would suggest. Give your genuine, precise assessment -- do not default to round numbers (ending in 0 or 5, or just below one like 92/82) out of habit; a fully honest assessment is just as likely to land on 77 or 88 as on 80 or 90.',
      tools: [
        {
          name: ANALYSIS_TOOL_NAME,
          description: 'Record the keyword match classification and fit score',
          input_schema: {
            type: 'object',
            properties: {
              fitScore: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                description:
                  "Your own holistic 0-100 judgment of how well this candidate fits the role overall -- weigh their full resume (seniority, depth of relevant experience, complementary/adjacent skills, domain alignment), not just literal keyword presence in the job description. This is deliberately separate from keyword coverage (computed elsewhere) and can legitimately sit above or below it. Give a genuinely precise number -- avoid defaulting to round or 'safe-looking' values (e.g. 70/80/90, or 72/82/92) out of habit.",
              },
              matchedKeywords: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'The subset of the GIVEN keyword list that the resume reflects (directly or via a clear synonym). Copy each entry verbatim from the given list -- do not paraphrase, split, combine, or invent keywords not in the given list.',
              },
            },
            required: ['fitScore', 'matchedKeywords'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: ANALYSIS_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: `Job description:\n${params.jobDescription}\n\nKeywords to classify:\n${params.keywords.join(', ')}\n\nResume:\n${params.resumeContent}`,
        },
      ],
    });

    const toolUseBlock = response.content.find(
      (block) => block.type === 'tool_use' && block.name === ANALYSIS_TOOL_NAME,
    );
    if (toolUseBlock?.type !== 'tool_use') {
      return { fitScore: 0, matchedKeywords: [] };
    }
    const input = toolUseBlock.input as { fitScore?: number; matchedKeywords?: string[] };
    return { fitScore: input.fitScore ?? 0, matchedKeywords: input.matchedKeywords ?? [] };
  }

  // Thin composition of the two methods above, uncached -- kept for
  // RecruiterSearchService's "best fit" ranking, which evaluates a
  // search query against many different candidates' profiles in one
  // batch (not a resume regenerated repeatedly against a fixed JD), so
  // the keyword-list caching ResumeGenerationsService does doesn't apply
  // here the same way. Preserves the original analyzeMatch behavior
  // exactly for that one remaining caller.
  async analyzeMatch(params: { jobDescription: string; resumeContent: string }): Promise<MatchAnalysis> {
    const keywords = await this.extractJobKeywords(params.jobDescription);
    const { fitScore, matchedKeywords } = await this.classifyKeywordMatches({
      jobDescription: params.jobDescription,
      keywords,
      resumeContent: params.resumeContent,
    });
    return {
      fitScore,
      matchedKeywords,
      missingKeywords: keywords.filter((k) => !matchedKeywords.includes(k)),
    };
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
        'You extract structured data from resumes. Call the record_experience_items tool exactly once with the contact info/bio you can find, plus every distinct experience, education entry, certification, project, achievement, skill, and spoken/written language. For languages, use the LANGUAGE type with the title as "Language (Proficiency)" e.g. "Spanish (Fluent)" if a proficiency is stated, otherwise just the language name. Do not invent anything not present in the text -- this includes dates: always set startDatePrecision/endDatePrecision to match exactly what the source stated (a resume that just says "2015 – 2019" for a degree is YEAR precision, not a real January date). isCurrent needs the same discipline: set it true ONLY when the source explicitly signals this is ongoing ("Present", "Current", "ongoing", or clearly present-tense framing of an end). If the entry simply has no end date stated and no such signal, set isCurrent false and leave endDate null -- do not assume something is current just because an end date wasn\'t given.',
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
                        'Same format and precision handling as startDate. Omit (null) if the source doesn\'t state one -- this covers BOTH "still ongoing" and "ended, date just not stated"; isCurrent below is what actually distinguishes the two, not this field.',
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
                    isCurrent: {
                      type: 'boolean',
                      description:
                        'True ONLY when the source explicitly signals this is ongoing (e.g. "Present", "Current", present-tense framing). False otherwise -- including when endDate simply wasn\'t stated. Only meaningful for EXPERIENCE/EDUCATION/PROJECT; always false for other types.',
                    },
                  },
                  required: ['type', 'title', 'isCurrent'],
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
