import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExperienceItemsService } from '../experience-items/experience-items.service.js';
import { buildGeneralResumeDocument } from '../resume-generations/deterministic-sections.js';
import { buildDocx } from './docx-builder.js';
import { buildPdf } from './pdf-builder.js';

const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

// The free, untailored download from the Profile page -- every catalog
// item as-is, no JD, no Claude call. Distinct from
// ResumeExportController (which exports a specific, already-tailored
// ResumeGeneration) -- this builds the document fresh from live profile
// data on every request, so it's always current.
@UseGuards(JwtAuthGuard)
@Controller('users/me/resume')
export class GeneralResumeExportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly experienceItemsService: ExperienceItemsService,
  ) {}

  @Get('export')
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ) {
    const [fullUser, items] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      this.experienceItemsService.findAllForUser(user.id),
    ]);

    const doc = buildGeneralResumeDocument(fullUser, items);

    const fileFormat = format === 'pdf' ? 'pdf' : 'docx';
    const buffer = fileFormat === 'pdf' ? await buildPdf(doc) : await buildDocx(doc);
    const filename = `${doc.name.replace(/\s+/g, '_')}_resume.${fileFormat}`;

    res.set({
      'Content-Type': CONTENT_TYPES[fileFormat],
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(buffer);
  }
}
