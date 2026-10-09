import { Module } from '@nestjs/common';
import { VoyageClient } from './voyage.client.js';
import { VectorService } from './vector.service.js';

@Module({
  providers: [VoyageClient, VectorService],
  exports: [VectorService],
})
export class VectorModule {}
