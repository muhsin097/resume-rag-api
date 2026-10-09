import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ExperienceFact {
  title: string;
  organization?: string | null;
  content: string;
}

export const EXTRACTABLE_TYPES = [
  'EXPERIENCE',
  'EDUCATION',
  'CERTIFICATION',
  'PROJECT',
  'ACHIEVEMENT',
  'SKILL',
] as const;

export interface ExtractedExperienceItem {
  type: (typeof EXTRACTABLE_TYPES)[number];
  title: string;
  organization?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
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

export interface MatchAnalysis {
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
}

const SYSTEM_PROMPT = `You are a resume-writing assistant.

You will be given a job description and a set of verified facts about a candidate's real experience, retrieved from their profile because they are the facts most semantically relevant to this job description.

Hard rules:
- Do NOT invent any experience, employer, skill, or achievement that is not present in the provided facts. You are rephrasing and prioritizing real facts, not generating new ones.
- You MAY reword, reorder, and emphasize the real facts to better match the job description's own terminology and keywords (this is what makes the resume ATS-friendly).
- If the provided facts are thin for this particular job, say so plainly in the output rather than padding with invented content.
- Output a clean resume in markdown (headings, bullet points) -- no commentary before or after it.`;

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
      phone?: string | null;
      location?: string | null;
      bio?: string | null;
    };
  }): Promise<string> {
    const factsBlock = params.facts
      .map((fact, index) => {
        const header = fact.organization
          ? `${fact.title} at ${fact.organization}`
          : fact.title;
        return `[Fact ${index + 1}] ${header}\n${fact.content}`;
      })
      .join('\n\n');

    const contactLines = [
      params.candidate.name,
      params.candidate.location,
      params.candidate.phone,
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
      messages: [
        {
          role: 'user',
          content: `Job description:\n${params.jobDescription}\n\nCandidate contact header (include verbatim at the top of the resume):\n${contactLines}\n${bioLine}\n\nCandidate's verified facts (most relevant first):\n${factsBlock}\n\nWrite a tailored resume using only the facts above.`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text : '';
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
        'You extract structured data from resumes. Call the record_experience_items tool exactly once with the contact info/bio you can find, plus every distinct experience, education entry, certification, project, achievement, and skill. Do not invent anything not present in the text.',
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
                        'ISO 8601 date (YYYY-MM-DD). Use the 1st of the month/year if only month or year is known. Omit (null) if unknown.',
                    },
                    endDate: {
                      type: ['string', 'null'],
                      description:
                        'Same format as startDate. Omit (null) if ongoing or unknown.',
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
