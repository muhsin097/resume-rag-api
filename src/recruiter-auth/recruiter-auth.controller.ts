import { Body, Controller, Post } from '@nestjs/common';
import { RecruiterAuthService } from './recruiter-auth.service.js';
import { RegisterRecruiterDto } from './dto/register-recruiter.dto.js';
import { LoginRecruiterDto } from './dto/login-recruiter.dto.js';
import { OAuthLoginDto } from '../auth/dto/oauth-login.dto.js';

@Controller('recruiter-auth')
export class RecruiterAuthController {
  constructor(private readonly recruiterAuthService: RecruiterAuthService) {}

  @Post('register')
  register(@Body() dto: RegisterRecruiterDto) {
    return this.recruiterAuthService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginRecruiterDto) {
    return this.recruiterAuthService.login(dto);
  }

  @Post('oauth')
  oauthLogin(@Body() dto: OAuthLoginDto) {
    return this.recruiterAuthService.oauthLogin(dto.idToken);
  }
}
