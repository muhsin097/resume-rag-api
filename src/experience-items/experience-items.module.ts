import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { ExperienceItemsController } from './experience-items.controller.js';
import { ExperienceItemsService } from './experience-items.service.js';

@Module({
  imports: [VectorModule],
  controllers: [ExperienceItemsController],
  providers: [ExperienceItemsService],
  exports: [ExperienceItemsService],
})
export class ExperienceItemsModule {}
