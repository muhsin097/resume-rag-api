import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SentryModule, SentryGlobalFilter } from '@sentry/nestjs/setup';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ExperienceItemsModule } from './experience-items/experience-items.module.js';
import { ResumeGenerationsModule } from './resume-generations/resume-generations.module.js';
import { HealthModule } from './health/health.module.js';
import { ResumeImportModule } from './resume-import/resume-import.module.js';
import { AdminModule } from './admin/admin.module.js';
import { RecruiterAuthModule } from './recruiter-auth/recruiter-auth.module.js';
import { RecruiterSearchModule } from './recruiter-search/recruiter-search.module.js';
import { ResumeExportModule } from './resume-export/resume-export.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PortfolioModule } from './portfolio/portfolio.module.js';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ExperienceItemsModule,
    ResumeGenerationsModule,
    HealthModule,
    ResumeImportModule,
    AdminModule,
    RecruiterAuthModule,
    RecruiterSearchModule,
    ResumeExportModule,
    PaymentsModule,
    PortfolioModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})
export class AppModule {}
