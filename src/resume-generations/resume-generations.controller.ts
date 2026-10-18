import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ResumeGenerationsService } from './resume-generations.service.js';
import { CreateResumeGenerationDto } from './dto/create-resume-generation.dto.js';

@UseGuards(JwtAuthGuard)
@Controller('resume-generations')
export class ResumeGenerationsController {
  constructor(
    private readonly resumeGenerationsService: ResumeGenerationsService,
  ) {}

  @Post()
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateResumeGenerationDto,
  ) {
    return this.resumeGenerationsService.generate(user.id, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.resumeGenerationsService.findAllForUser(
      user.id,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.resumeGenerationsService.findOneForUser(user.id, id);
  }
}
