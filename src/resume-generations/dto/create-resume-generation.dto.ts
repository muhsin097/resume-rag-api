import { IsString, MinLength } from 'class-validator';

export class CreateResumeGenerationDto {
  @IsString()
  @MinLength(20)
  jobDescription!: string;
}
