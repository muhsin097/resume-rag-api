import { IsString, MinLength } from 'class-validator';

export class SearchCandidatesDto {
  @IsString()
  @MinLength(1)
  query!: string;
}
