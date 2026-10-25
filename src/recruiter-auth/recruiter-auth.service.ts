import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { RegisterRecruiterDto } from './dto/register-recruiter.dto.js';
import { LoginRecruiterDto } from './dto/login-recruiter.dto.js';
import { verifyGoogleIdToken } from '../auth/google-id-token.js';

const PASSWORD_HASH_ROUNDS = 10;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
// Same reasoning as AuthService's OTP_MAX_ATTEMPTS -- bounds how many
// guesses a 6-digit code can take before it's invalidated outright.
const OTP_MAX_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class RecruiterAuthService {
  private readonly logger = new Logger(RecruiterAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
  ) {}

  // Used to just create the account and hand back a real access token
  // immediately -- no proof the caller controls the email at all, so
  // anyone could register as e.g. "hr@some-real-company.com" and start
  // searching/emailing candidates under that identity. Now mirrors the
  // candidate flow: no token until the OTP is verified.
  async register(dto: RegisterRecruiterDto) {
    // Emails are case-insensitive, same normalization as the candidate side.
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.recruiter.findUnique({
      where: { email },
    });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    const code = generateVerificationCode();
    await this.prisma.recruiter.create({
      data: {
        email,
        passwordHash,
        name: dto.name,
        companyName: dto.companyName,
        emailVerificationCodeHash: hashCode(code),
        emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    try {
      await this.emailService.sendVerificationEmail(email, code);
    } catch (err) {
      this.logger.error('Failed to send verification email', err instanceof Error ? err.stack : err);
    }
    return { pendingVerification: true, email };
  }

  async login(dto: LoginRecruiterDto) {
    const recruiter = await this.prisma.recruiter.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    // No passwordHash means this account was created via Google OAuth.
    if (!recruiter || !recruiter.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      recruiter.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!recruiter.emailVerifiedAt) {
      throw new ForbiddenException('Please verify your email before logging in.');
    }

    return this.buildAuthResponse(recruiter);
  }

  // Same shape as AuthService.verifyEmail -- see its comments for why
  // the attempt cap invalidates the code rather than just counting.
  async verifyEmail(email: string, code: string) {
    const recruiter = await this.prisma.recruiter.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (
      !recruiter ||
      !recruiter.emailVerificationCodeHash ||
      !recruiter.emailVerificationExpiresAt ||
      recruiter.emailVerificationExpiresAt < new Date()
    ) {
      throw new BadRequestException('That code is incorrect or has expired.');
    }

    if (recruiter.emailVerificationCodeHash !== hashCode(code)) {
      if (recruiter.emailVerificationAttempts + 1 >= OTP_MAX_ATTEMPTS) {
        await this.prisma.recruiter.update({
          where: { id: recruiter.id },
          data: {
            emailVerificationCodeHash: null,
            emailVerificationExpiresAt: null,
            emailVerificationAttempts: 0,
          },
        });
        throw new BadRequestException(
          'Too many incorrect attempts. Request a new code and try again.',
        );
      }
      await this.prisma.recruiter.update({
        where: { id: recruiter.id },
        data: { emailVerificationAttempts: { increment: 1 } },
      });
      throw new BadRequestException('That code is incorrect or has expired.');
    }

    const verified = await this.prisma.recruiter.update({
      where: { id: recruiter.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationCodeHash: null,
        emailVerificationExpiresAt: null,
        emailVerificationAttempts: 0,
      },
    });

    return this.buildAuthResponse(verified);
  }

  // Same non-enumeration posture as AuthService.resendVerificationCode --
  // always resolves the same way, failures logged rather than surfaced.
  async resendVerificationCode(email: string): Promise<void> {
    const recruiter = await this.prisma.recruiter.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!recruiter || recruiter.emailVerifiedAt) return;

    const code = generateVerificationCode();
    await this.prisma.recruiter.update({
      where: { id: recruiter.id },
      data: {
        emailVerificationCodeHash: hashCode(code),
        emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        emailVerificationAttempts: 0,
      },
    });

    try {
      await this.emailService.sendVerificationEmail(recruiter.email, code);
    } catch (err) {
      this.logger.error('Failed to resend verification email', err instanceof Error ? err.stack : err);
    }
  }

  // Called from resume-rag-web's NextAuth jwt callback after Google has
  // already verified the email -- same trust boundary as AuthService's
  // The stale assumption this comment used to make ("api has no public
  // port, only reachable from resume-rag-web over the compose network")
  // was never actually true once Caddy started proxying the whole API
  // unrestricted -- this endpoint was reachable directly, and a plain
  // POST with any existing recruiter's email returned a valid token, no
  // Google involvement at all. Now verifies Google's own ID token
  // server-side and uses ONLY the verified payload's email/name -- see
  // google-id-token.ts.
  async oauthLogin(idToken: string) {
    const identity = await verifyGoogleIdToken(idToken);
    const normalizedEmail = identity.email.toLowerCase();
    // Google already proved this email, so it counts as verified here
    // too -- set on both branches, same as AuthService.oauthLogin, so a
    // password account that never finished its own OTP flow still gets
    // unblocked once it proves the same email via Google.
    const recruiter = await this.prisma.recruiter.upsert({
      where: { email: normalizedEmail },
      update: { emailVerifiedAt: new Date() },
      create: { email: normalizedEmail, name: identity.name, emailVerifiedAt: new Date() },
    });

    return this.buildAuthResponse(recruiter);
  }

  private buildAuthResponse(recruiter: {
    id: string;
    email: string;
    name: string;
    companyName: string | null;
  }) {
    // kind: 'recruiter' is what lets guards reject a candidate token here
    // and vice versa -- the two strategies live under different Passport
    // strategy names, but this claim is what resume-rag-web's NextAuth
    // session uses to tell the two personas apart client-side.
    const accessToken = this.jwtService.sign({
      sub: recruiter.id,
      email: recruiter.email,
      kind: 'recruiter',
    });

    return {
      accessToken,
      recruiter: {
        id: recruiter.id,
        email: recruiter.email,
        name: recruiter.name,
        companyName: recruiter.companyName,
      },
    };
  }
}
