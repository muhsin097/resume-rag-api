import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { ResumeGenerationsController } from './resume-generations.controller.js';
import { ResumeGenerationsService } from './resume-generations.service.js';

@Module({
  imports: [VectorModule, LlmModule],
  controllers: [ResumeGenerationsController],
  providers: [ResumeGenerationsService],
})
export class ResumeGenerationsModule {}
