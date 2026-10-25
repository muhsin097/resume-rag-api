import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { EmailModule } from '../email/email.module.js';
import { RecruiterAuthController } from './recruiter-auth.controller.js';
import { RecruiterAuthService } from './recruiter-auth.service.js';
import { RecruiterJwtStrategy } from './strategies/recruiter-jwt.strategy.js';

@Module({
  imports: [
    PassportModule,
    EmailModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [RecruiterAuthController],
  providers: [RecruiterAuthService, RecruiterJwtStrategy],
  exports: [RecruiterAuthService],
})
export class RecruiterAuthModule {}
