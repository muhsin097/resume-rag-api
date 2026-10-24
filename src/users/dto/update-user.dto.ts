import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsBoolean()
  jobSearchEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  portfolioEnabled?: boolean;

  // Lowercase alphanumeric + hyphens only, no leading/trailing/double
  // hyphen -- keeps it readable in a URL and avoids needing to
  // percent-encode anything. Length bounds are just sane UX limits, not
  // a security concern.
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase letters, numbers, and single hyphens only (e.g. "jane-doe").',
  })
  portfolioSlug?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  linkedinUrl?: string;

  @IsOptional()
  @IsString()
  githubUrl?: string;

  @IsOptional()
  @IsString()
  websiteUrl?: string;
}
