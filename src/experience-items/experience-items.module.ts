import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { ExperienceItemsController } from './experience-items.controller.js';
import { ExperienceItemsService } from './experience-items.service.js';

@Module({
  imports: [VectorModule, LlmModule],
  controllers: [ExperienceItemsController],
  providers: [ExperienceItemsService],
  exports: [ExperienceItemsService],
})
export class ExperienceItemsModule {}
