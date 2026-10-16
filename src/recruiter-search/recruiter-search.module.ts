import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { RecruiterSearchController } from './recruiter-search.controller.js';
import { RecruiterSearchService } from './recruiter-search.service.js';

@Module({
  imports: [VectorModule, LlmModule],
  controllers: [RecruiterSearchController],
  providers: [RecruiterSearchService],
})
export class RecruiterSearchModule {}
