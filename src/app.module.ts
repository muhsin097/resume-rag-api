import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { ExperienceItemsModule } from './experience-items/experience-items.module.js';
import { ResumeGenerationsModule } from './resume-generations/resume-generations.module.js';
import { HealthModule } from './health/health.module.js';
import { ResumeImportModule } from './resume-import/resume-import.module.js';
import { AdminModule } from './admin/admin.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ExperienceItemsModule,
    ResumeGenerationsModule,
    HealthModule,
    ResumeImportModule,
    AdminModule,
  ],
})
export class AppModule {}
