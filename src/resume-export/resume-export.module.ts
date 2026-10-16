import { Module } from '@nestjs/common';
import { ResumeGenerationsModule } from '../resume-generations/resume-generations.module.js';
import { ResumeExportController } from './resume-export.controller.js';

@Module({
  imports: [ResumeGenerationsModule],
  controllers: [ResumeExportController],
})
export class ResumeExportModule {}
