import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { RecruiterJwtAuthGuard } from '../recruiter-auth/guards/recruiter-jwt-auth.guard.js';
import { CurrentRecruiter } from '../recruiter-auth/decorators/current-recruiter.decorator.js';
import type { AuthenticatedRecruiter } from '../recruiter-auth/decorators/current-recruiter.decorator.js';
import { RecruiterSearchService } from './recruiter-search.service.js';
import { SearchCandidatesDto } from './dto/search-candidates.dto.js';

@UseGuards(RecruiterJwtAuthGuard)
@Controller('recruiter')
export class RecruiterSearchController {
  constructor(private readonly recruiterSearchService: RecruiterSearchService) {}

  @Get('me')
  me(@CurrentRecruiter() recruiter: AuthenticatedRecruiter) {
    return this.recruiterSearchService.getMe(recruiter.id);
  }

  @Post('search')
  search(@Body() dto: SearchCandidatesDto) {
    return this.recruiterSearchService.search(dto);
  }

  @Post('search/best-fit')
  findBestFit(
    @CurrentRecruiter() recruiter: AuthenticatedRecruiter,
    @Body() dto: SearchCandidatesDto,
  ) {
    return this.recruiterSearchService.findBestFit(recruiter.id, dto);
  }

  @Get('candidates/:id')
  getCandidate(@Param('id') id: string) {
    return this.recruiterSearchService.getCandidate(id);
  }
}
