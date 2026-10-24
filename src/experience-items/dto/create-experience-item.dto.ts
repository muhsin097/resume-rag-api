import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ExperienceType, DatePrecision } from '../../generated/prisma/enums.js';

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

  @IsOptional()
  @IsEnum(DatePrecision)
  startDatePrecision?: DatePrecision;

  @IsOptional()
  @IsEnum(DatePrecision)
  endDatePrecision?: DatePrecision;

  // Disambiguates "still ongoing" from "ended, exact date unknown" --
  // both otherwise look identical as a null endDate. See
  // ExperienceItem.isCurrent in the Prisma schema.
  @IsOptional()
  @IsBoolean()
  isCurrent?: boolean;

  // Only meaningful for type PROJECT. "At most one per user" is enforced
  // in ExperienceItemsService.update, not here.
  @IsOptional()
  @IsBoolean()
  isHighlighted?: boolean;
}
