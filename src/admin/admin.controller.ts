import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { AdminService } from './admin.service.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { ListExperienceItemsQueryDto } from './dto/list-experience-items-query.dto.js';
import { ListGenerationsQueryDto } from './dto/list-generations-query.dto.js';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('overview')
  getOverview() {
    return this.adminService.getOverview();
  }

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Get('users/:id')
  getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Get('experience-items')
  listExperienceItems(@Query() query: ListExperienceItemsQueryDto) {
    return this.adminService.listExperienceItems(query);
  }

  @Get('resume-generations')
  listGenerations(@Query() query: ListGenerationsQueryDto) {
    return this.adminService.listGenerations(query);
  }
}
