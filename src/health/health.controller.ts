import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';

// This is the ECS/ALB health check target in production (see
// resume-rag-infra's task 8) -- it has to actually prove the app can reach
// its database, not just that the HTTP server is up.
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () =>
        this.healthIndicatorService
          .check('database')
          .attempt(() => this.prisma.$queryRaw`SELECT 1`),
    ]);
  }
}
