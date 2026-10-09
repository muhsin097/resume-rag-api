import { IsDateString, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ExperienceType } from '../../generated/prisma/enums.js';

export class CreateExperienceItemDto {
  @IsEnum(ExperienceType)
  type!: ExperienceType;

  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}
