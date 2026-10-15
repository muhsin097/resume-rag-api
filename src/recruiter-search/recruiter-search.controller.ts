import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { RecruiterJwtAuthGuard } from '../recruiter-auth/guards/recruiter-jwt-auth.guard.js';
import { RecruiterSearchService } from './recruiter-search.service.js';
import { SearchCandidatesDto } from './dto/search-candidates.dto.js';

@UseGuards(RecruiterJwtAuthGuard)
@Controller('recruiter')
export class RecruiterSearchController {
  constructor(private readonly recruiterSearchService: RecruiterSearchService) {}

  @Post('search')
  search(@Body() dto: SearchCandidatesDto) {
    return this.recruiterSearchService.search(dto);
  }

  @Get('candidates/:id')
  getCandidate(@Param('id') id: string) {
    return this.recruiterSearchService.getCandidate(id);
  }
}
