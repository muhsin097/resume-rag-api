import { BadRequestException, Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { ClaudeClient, ExtractedResumeData } from '../llm/claude.client.js';

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT_MIME = 'text/plain';

@Injectable()
export class ResumeImportService {
  constructor(private readonly claudeClient: ClaudeClient) {}

  async extractExperienceItems(
    file: Express.Multer.File,
  ): Promise<ExtractedResumeData> {
    const text = await this.extractText(file);
    if (!text.trim()) {
      throw new BadRequestException(
        'Could not read any text from this file.',
      );
    }
    return this.claudeClient.extractExperienceItemsFromResume(text);
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
