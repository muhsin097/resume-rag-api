import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClaudeClient, ExtractedResumeData } from '../llm/claude.client.js';

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT_MIME = 'text/plain';

// Resume import is a free onboarding utility, not a metered generation --
// but with no cap at all it was an unmetered Claude cost vector (nothing
// stopped looping the upload endpoint). This is deliberately generous
// (most people import once, maybe twice if they update their master
// resume) and deliberately separate from creditsBalance, so imports never
// eat into paid generation credits.
const DEFAULT_IMPORT_LIMIT = 5;

@Injectable()
export class ResumeImportService {
  constructor(
    private readonly claudeClient: ClaudeClient,
    private readonly prisma: PrismaService,
  ) {}

  async extractExperienceItems(
    userId: string,
    file: Express.Multer.File,
  ): Promise<ExtractedResumeData> {
    // Reserved before the Claude call, as one atomic conditional UPDATE --
    // same reasoning as the generation credit reservation: a
    // check-then-increment across two statements would let concurrent
    // requests both pass against the same stale count.
    const limit = Number(process.env.FREE_IMPORT_LIMIT ?? DEFAULT_IMPORT_LIMIT);
    const reserved = await this.prisma.user.updateMany({
      where: { id: userId, resumeImportsUsed: { lt: limit } },
      data: { resumeImportsUsed: { increment: 1 } },
    });
    if (reserved.count === 0) {
      throw new ForbiddenException(
        'You\'ve reached the free resume-import limit for this account.',
      );
    }

    try {
      const text = await this.extractText(file);
      if (!text.trim()) {
        throw new BadRequestException(
          'Could not read any text from this file.',
        );
      }
      return await this.claudeClient.extractExperienceItemsFromResume(text);
    } catch (err) {
      // The reservation above already happened -- an unreadable file or a
      // failed Claude call never actually used it, so refund rather than
      // burn an import slot on an attempt that didn't go anywhere.
      await this.prisma.user
        .update({ where: { id: userId }, data: { resumeImportsUsed: { decrement: 1 } } })
        .catch(() => {});
      throw err;
    }
  }

  private async extractText(file: Express.Multer.File): Promise<string> {
    switch (file.mimetype) {
      case PDF_MIME: {
        const parser = new PDFParse({ data: file.buffer });
        try {
          const result = await parser.getText();
          return result.text;
        } finally {
          await parser.destroy();
        }
      }
      case DOCX_MIME: {
        const { value } = await mammoth.extractRawText({
          buffer: file.buffer,
        });
        return value;
      }
      case TXT_MIME:
        return file.buffer.toString('utf-8');
      default:
        throw new BadRequestException(
          'Unsupported file type. Upload a PDF, DOCX, or plain text resume.',
        );
    }
  }
}
