import { ArrayMaxSize, IsBoolean, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// The "+" button on a red/missing JD keyword -- the candidate is asking
// to add it to their Skills. saveToProfile controls whether an approved
// keyword also gets persisted as a real SKILL fact (shows up in every
// future generation) or only applied to this one regeneration.
export class RequestedSkillDto {
  @IsString()
  @MinLength(1)
  keyword!: string;

  @IsBoolean()
  saveToProfile!: boolean;
}

export class CreateResumeGenerationDto {
  @IsString()
  @MinLength(20)
  jobDescription!: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RequestedSkillDto)
  @ArrayMaxSize(10)
  requestedSkills?: RequestedSkillDto[];
}
