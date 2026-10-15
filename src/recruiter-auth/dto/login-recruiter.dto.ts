import { IsEmail, IsString } from 'class-validator';

export class LoginRecruiterDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
