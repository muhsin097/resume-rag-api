import { IsEmail, IsString, MinLength } from 'class-validator';

export class OAuthLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  name!: string;
}
