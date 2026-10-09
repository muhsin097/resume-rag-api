import { Module } from '@nestjs/common';
import { ClaudeClient } from './claude.client.js';

@Module({
  providers: [ClaudeClient],
  exports: [ClaudeClient],
})
export class LlmModule {}
