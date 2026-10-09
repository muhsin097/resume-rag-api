import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { ExperienceItemsService } from './experience-items.service.js';
import { CreateExperienceItemDto } from './dto/create-experience-item.dto.js';
import { CreateExperienceItemsBulkDto } from './dto/create-experience-items-bulk.dto.js';
import { UpdateExperienceItemDto } from './dto/update-experience-item.dto.js';

@UseGuards(JwtAuthGuard)
@Controller('experience-items')
export class ExperienceItemsController {
  constructor(private readonly experienceItemsService: ExperienceItemsService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.experienceItemsService.findAllForUser(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.experienceItemsService.findOneForUser(user.id, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExperienceItemDto,
  ) {
    return this.experienceItemsService.create(user.id, dto);
  }

  @Post('bulk')
  createMany(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExperienceItemsBulkDto,
  ) {
    return this.experienceItemsService.createMany(user.id, dto.items);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateExperienceItemDto,
  ) {
    return this.experienceItemsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.experienceItemsService.remove(user.id, id);
  }
}
