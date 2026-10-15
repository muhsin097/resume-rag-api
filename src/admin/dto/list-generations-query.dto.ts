import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class ListGenerationsQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(['createdAt', 'matchScore'])
  sortBy?: 'createdAt' | 'matchScore';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
