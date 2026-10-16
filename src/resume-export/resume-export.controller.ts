import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ResumeGenerationsService } from '../resume-generations/resume-generations.service.js';
import type { ResumeDocument } from '../llm/claude.client.js';
import { buildDocx } from './docx-builder.js';
import { buildPdf } from './pdf-builder.js';

const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
} as const;

@UseGuards(JwtAuthGuard)
@Controller('resume-generations')
export class ResumeExportController {
  constructor(private readonly resumeGenerationsService: ResumeGenerationsService) {}

  @Get(':id/export')
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ) {
    const generation = await this.resumeGenerationsService.findOneForUser(user.id, id);
    const doc = generation.structuredContent as ResumeDocument | null;
    if (!doc) {
      throw new NotFoundException(
        'Download is not available for generations created before this feature shipped.',
      );
    }

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
