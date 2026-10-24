import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PortfolioService } from './portfolio.service.js';
import { CreateLeadDto } from './dto/create-lead.dto.js';

// Fully public, unauthenticated -- anyone with a shared link can view a
// profile or submit a lead. No JwtAuthGuard anywhere in this controller.
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get(':slug')
  getProfile(@Param('slug') slug: string) {
    return this.portfolioService.getPublicProfile(slug);
  }

  // Per-IP limit on top of PortfolioService's per-visitor-email dedupe --
  // this catches a single source hammering the endpoint with different
  // emails, which the dedupe alone wouldn't stop.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':slug/leads')
  @HttpCode(200)
  async submitLead(@Param('slug') slug: string, @Body() dto: CreateLeadDto) {
    await this.portfolioService.submitLead(slug, dto);
    return { message: 'Thanks -- your interest has been sent.' };
  }
}
