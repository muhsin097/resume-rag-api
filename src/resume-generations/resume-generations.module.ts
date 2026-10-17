import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { ExperienceItemsModule } from '../experience-items/experience-items.module.js';
import { ResumeGenerationsController } from './resume-generations.controller.js';
import { ResumeGenerationsService } from './resume-generations.service.js';

@Module({
  imports: [VectorModule, LlmModule, ExperienceItemsModule],
  controllers: [ResumeGenerationsController],
  providers: [ResumeGenerationsService],
  exports: [ResumeGenerationsService],
})
export class ResumeGenerationsModule {}
