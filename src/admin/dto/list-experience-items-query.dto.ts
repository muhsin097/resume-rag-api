import { IsEnum, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ExperienceType } from '../../generated/prisma/enums.js';

export class ListExperienceItemsQueryDto {
  @IsOptional()
  @IsEnum(ExperienceType)
  type?: ExperienceType;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['createdAt', 'startDate'])
  sortBy?: 'createdAt' | 'startDate';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
