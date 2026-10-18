import { Module } from '@nestjs/common';
import { ResumeGenerationsModule } from '../resume-generations/resume-generations.module.js';
import { ExperienceItemsModule } from '../experience-items/experience-items.module.js';
import { ResumeExportController } from './resume-export.controller.js';
import { GeneralResumeExportController } from './general-resume-export.controller.js';

@Module({
  imports: [ResumeGenerationsModule, ExperienceItemsModule],
  controllers: [ResumeExportController, GeneralResumeExportController],
})
export class ResumeExportModule {}
