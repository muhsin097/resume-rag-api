import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// The "+" button on a red/missing JD keyword. No AI approval gate --
// clicking it IS the candidate's confirmation that they genuinely have
// this skill (the checkbox copy on the frontend says so explicitly), the
// same trust already extended to everything else they type into their
// profile. saveToProfile controls whether it also persists as a real
// SKILL fact (shows up in every future generation) or only applies to
// this one resume.
export class SkillToAddDto {
  @IsString()
  @MinLength(1)
  keyword!: string;

  @IsBoolean()
  saveToProfile!: boolean;
}

// Accepts a batch, not one keyword per request -- when saveToProfile is
// true for several of them, they're persisted via
// ExperienceItemsService.createMany, which embeds and categorizes the
// whole batch in ONE Voyage call and ONE Claude call. Calling this once
// per keyword (the original shape) meant staging 3-4 skills made 3-4
// separate Voyage embed requests in quick succession, straight into
// Voyage's free-tier 3-requests/minute cap -- requests past the limit
// failed, and were silently swallowed by a blanket catch, so only
// whichever keyword won the race actually got saved despite the UI
// reporting success for all of them.
export class AddSkillsDto {
  @ValidateNested({ each: true })
  @Type(() => SkillToAddDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  skills!: SkillToAddDto[];
}
