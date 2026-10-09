import { Type } from 'class-transformer';
import { ArrayMinSize, ValidateNested } from 'class-validator';
import { CreateExperienceItemDto } from './create-experience-item.dto.js';

export class CreateExperienceItemsBulkDto {
  @ValidateNested({ each: true })
  @Type(() => CreateExperienceItemDto)
  @ArrayMinSize(1)
  items!: CreateExperienceItemDto[];
}
