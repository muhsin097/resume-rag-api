import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { ResumeImportController } from './resume-import.controller.js';
import { ResumeImportService } from './resume-import.service.js';

@Module({
  imports: [LlmModule],
  controllers: [ResumeImportController],
  providers: [ResumeImportService],
})
export class ResumeImportModule {}
