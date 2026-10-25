import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { RecruiterAuthService } from './recruiter-auth.service.js';
import { RegisterRecruiterDto } from './dto/register-recruiter.dto.js';
import { LoginRecruiterDto } from './dto/login-recruiter.dto.js';
import { OAuthLoginDto } from '../auth/dto/oauth-login.dto.js';
import { VerifyEmailDto } from '../auth/dto/verify-email.dto.js';
import { ResendVerificationDto } from '../auth/dto/resend-verification.dto.js';

@Controller('recruiter-auth')
export class RecruiterAuthController {
  constructor(private readonly recruiterAuthService: RecruiterAuthService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterRecruiterDto) {
    return this.recruiterAuthService.register(dto);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginRecruiterDto) {
    return this.recruiterAuthService.login(dto);
  }

  @Post('oauth')
  oauthLogin(@Body() dto: OAuthLoginDto) {
    return this.recruiterAuthService.oauthLogin(dto.idToken);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.recruiterAuthService.verifyEmail(dto.email, dto.code);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('resend-verification')
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.recruiterAuthService.resendVerificationCode(dto.email);
    return { message: 'If that account needs verifying, a new code has been sent.' };
  }
}
