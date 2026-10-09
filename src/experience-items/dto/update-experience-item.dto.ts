import { PartialType } from '@nestjs/mapped-types';
import { CreateExperienceItemDto } from './create-experience-item.dto.js';

export class UpdateExperienceItemDto extends PartialType(
  CreateExperienceItemDto,
) {}
