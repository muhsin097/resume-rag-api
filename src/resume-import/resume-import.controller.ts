import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ResumeImportService } from './resume-import.service.js';

const MAX_RESUME_FILE_BYTES = 5 * 1024 * 1024;

@UseGuards(JwtAuthGuard)
@Controller('resume-import')
export class ResumeImportController {
  constructor(private readonly resumeImportService: ResumeImportService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_RESUME_FILE_BYTES },
    }),
  )
  async extract(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file was uploaded.');
    }
    return this.resumeImportService.extractExperienceItems(user.id, file);
  }
}
