import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { ExperienceType } from '../generated/prisma/enums.js';
import { keywordAppearsInResume } from '../resume-generations/resume-generations.service.js';
import { CreateLeadDto } from './dto/create-lead.dto.js';

// A submission for the same visitor email against the same portfolio
// within this window is treated as a duplicate (silently no-op, not an
// error) -- stops a repeated/accidental click, or a deliberate spam
// attempt against one visitor email, from paging the owner more than
// once in a day for the same person.
const LEAD_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  bio: true,
  location: true,
  linkedinUrl: true,
  githubUrl: true,
  websiteUrl: true,
} as const;

export interface PublicExperienceItem {
  id: string;
  title: string;
  organization: string | null;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
}

export interface PortfolioSkill {
  title: string;
  category: string | null;
  // How many Experience/Project entries actually mention this skill --
  // the point of the whole feature: a skill backed by real evidence
  // should read differently from a bare self-reported tag. See
  // computeSkillEvidence below.
  evidenceCount: number;
  roles: string[];
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async getPublicProfile(slug: string) {
    // portfolioEnabled is part of the lookup itself, not a check after
    // the fact -- a disabled portfolio should 404 exactly like a slug
    // that was never claimed, not reveal that the slug exists.
    const user = await this.prisma.user.findFirst({
      where: { portfolioSlug: slug, portfolioEnabled: true },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException('Portfolio not found.');
    }

    const items = await this.prisma.experienceItem.findMany({
      where: { userId: user.id },
      orderBy: { startDate: 'desc' },
    });

    const byType = (type: ExperienceType) => items.filter((item) => item.type === type);
    const experience = byType(ExperienceType.EXPERIENCE);
    const projects = byType(ExperienceType.PROJECT);
    const skills = byType(ExperienceType.SKILL);

    return {
      name: user.name,
      bio: user.bio,
      location: user.location,
      linkedinUrl: user.linkedinUrl,
      githubUrl: user.githubUrl,
      websiteUrl: user.websiteUrl,
      skills: computeSkillEvidence(skills, [...experience, ...projects]),
      experience: experience.map(toPublicExperienceItem),
      projects: projects.map(toPublicExperienceItem),
      education: byType(ExperienceType.EDUCATION).map(toPublicExperienceItem),
      certifications: byType(ExperienceType.CERTIFICATION).map(toPublicExperienceItem),
      languages: byType(ExperienceType.LANGUAGE).map((item) => ({ title: item.title })),
      achievements: byType(ExperienceType.ACHIEVEMENT).map((item) => ({
        title: item.title,
        description: item.description,
      })),
    };
  }

  // Rate limiting (per-IP, across all slugs) is applied at the route
  // level via ThrottlerGuard -- this handles the per-visitor dedupe,
  // which needs the specific (userId, visitorEmail) pair the throttler
  // guard doesn't see.
  async submitLead(slug: string, dto: CreateLeadDto): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { portfolioSlug: slug, portfolioEnabled: true },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('Portfolio not found.');
    }

    const recentDuplicate = await this.prisma.portfolioLead.findFirst({
      where: {
        userId: user.id,
        visitorEmail: dto.visitorEmail,
        createdAt: { gt: new Date(Date.now() - LEAD_DEDUPE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recentDuplicate) {
      // Same outward behavior as a fresh submission -- no need for the
      // visitor to know whether this was a duplicate.
      return;
    }

    await this.prisma.portfolioLead.create({
      data: {
        userId: user.id,
        visitorEmail: dto.visitorEmail,
        visitorName: dto.visitorName,
        message: dto.message,
      },
    });

    // Best-effort, same pattern as the verification/reset emails
    // elsewhere in this codebase -- the lead is already recorded (and
    // will show up in the owner's dashboard regardless), so a transient
    // Resend failure shouldn't fail the visitor's submission.
    try {
      await this.emailService.sendPortfolioLeadNotification(user.email, {
        visitorEmail: dto.visitorEmail,
        visitorName: dto.visitorName,
        message: dto.message,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send portfolio lead notification to ${user.email}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}

function toPublicExperienceItem(item: {
  id: string;
  title: string;
  organization: string | null;
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isCurrent: boolean;
}): PublicExperienceItem {
  return {
    id: item.id,
    title: item.title,
    organization: item.organization,
    description: item.description,
    startDate: item.startDate,
    endDate: item.endDate,
    isCurrent: item.isCurrent,
  };
}

// For each skill, counts how many Experience/Project entries actually
// mention it (via the same word-boundary-safe matcher used to reconcile
// JD keywords against a generated resume) and records which roles. A
// skill with zero evidence isn't hidden -- still a real, self-reported
// fact -- but the frontend can visually rank/distinguish "evidenced"
// skills from bare ones, which is the whole point of this over a flat
// tag list.
function computeSkillEvidence(
  skills: { title: string; category: string | null }[],
  experienceAndProjects: { title: string; organization: string | null; content: string }[],
): PortfolioSkill[] {
  const results = skills.map((skill) => {
    const matches = experienceAndProjects.filter((item) => keywordAppearsInResume(skill.title, item.content));
    return {
      title: skill.title,
      category: skill.category,
      evidenceCount: matches.length,
      roles: matches.map((item) => (item.organization ? `${item.title} at ${item.organization}` : item.title)),
    };
  });
  return results.sort((a, b) => b.evidenceCount - a.evidenceCount);
}
