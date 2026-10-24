import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EmailModule } from '../email/email.module.js';
import { PortfolioController } from './portfolio.controller.js';
import { PortfolioService } from './portfolio.service.js';

@Module({
  // Scoped here, not registered globally in AppModule -- the throttler
  // guard is only applied explicitly on the one public, unauthenticated
  // route that actually needs it (see PortfolioController.submitLead),
  // so this can't accidentally affect any other route's behavior.
  imports: [PrismaModule, EmailModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }])],
  controllers: [PortfolioController],
  providers: [PortfolioService],
})
export class PortfolioModule {}
