import { IsBoolean, IsString, MinLength } from 'class-validator';

// The "+" button on a red/missing JD keyword. No AI approval gate --
// clicking it IS the candidate's confirmation that they genuinely have
// this skill (the checkbox copy on the frontend says so explicitly), the
// same trust already extended to everything else they type into their
// profile. saveToProfile controls whether it also persists as a real
// SKILL fact (shows up in every future generation) or only applies to
// this one resume.
export class AddSkillDto {
  @IsString()
  @MinLength(1)
  keyword!: string;

  @IsBoolean()
  saveToProfile!: boolean;
}
