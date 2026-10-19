import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

const PASSWORD_HASH_ROUNDS = 10;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  async register(dto: RegisterDto) {
    // Emails are case-insensitive -- normalize before every lookup/write so
    // "Name@x.com" and "name@x.com" are always the same account.
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);

    if (existing) {
      // Reactivating a previously-deleted account rather than creating a
      // new one -- freeGenerationsUsed and plan are deliberately left
      // untouched, so delete-then-re-register doesn't reset the free tier
      // back to zero. Still goes through the OTP step like any other
      // registration, though, and emailVerifiedAt is explicitly cleared
      // here (deleteAccount() never touches it, so it would otherwise
      // still hold its old value): registering also sets a brand new
      // password, so the fact that THIS email was verified at some point
      // in the past doesn't mean the CURRENT caller controls the mailbox
      // right now. Skipping verification -- or leaving a stale
      // emailVerifiedAt in place that login() would still honor -- would
      // let anyone who merely knows a victim's email "reactivate" their
      // old account (and inherit its plan/usage) without ever proving
      // mailbox ownership.
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { name: dto.name, passwordHash, deletedAt: null, emailVerifiedAt: null },
      });
    } else {
      await this.prisma.user.create({
        data: { email, passwordHash, name: dto.name },
      });
    }

    // No accessToken yet -- the account can't log in until the code is
    // verified, so there's nothing to hand back but a pointer to that
    // next step.
    const code = generateVerificationCode();
    await this.prisma.user.update({
      where: { email },
      data: {
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

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    // No passwordHash covers three cases that already look identical from
    // outside (so this message doesn't leak anything new): the email was
    // never registered, it's a Google-only account with nothing to
    // compare against, or it's a deleted account (deleteAccount() clears
    // passwordHash). All three need the same next step -- there's no
    // password-based login available for this email right now.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException(
        "This email doesn't have a password set, or isn't registered. Try Google sign-in, or register below.",
      );
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Please verify your email before logging in.');
    }

    return this.buildAuthResponse(user);
  }

  // Called from resume-rag-web's NextAuth jwt callback after Google has
  // already verified the email -- never reachable from outside the compose
  // network (api has no public port), so there's no path for an outside
  // caller to assert an arbitrary email here.
  async oauthLogin(email: string, name: string) {
    const normalizedEmail = email.toLowerCase();
    // Google already proved this email, so it counts as verified here too
    // -- set on both branches: `create` for a brand new account, `update`
    // so a password account that never finished its own OTP flow still
    // gets unblocked once it proves the same email via Google. `deletedAt:
    // null` reactivates a previously-deleted account the same way
    // register() does -- freeGenerationsUsed stays whatever it already
    // was, not reset.
    const user = await this.prisma.user.upsert({
      where: { email: normalizedEmail },
      update: { emailVerifiedAt: new Date(), deletedAt: null },
      create: { email: normalizedEmail, name, emailVerifiedAt: new Date() },
    });

    return this.buildAuthResponse(user);
  }

  // Always resolves the same way whether or not the account exists, or
  // whether it even has a password to reset (Google-only accounts don't)
  // -- otherwise this endpoint becomes an oracle for which emails have an
  // account here.
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user || !user.passwordHash) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
      },
    });

    const webOrigin = this.configService.get<string>('WEB_ORIGIN') ?? 'https://ceasetoresume.online';
    const resetUrl = `${webOrigin}/reset-password?token=${rawToken}`;
    try {
      await this.emailService.sendPasswordResetEmail(user.email, resetUrl);
    } catch (err) {
      // Swallowed on purpose: this method must behave identically whether
      // the account exists or not, so a misconfigured key or a provider
      // outage can't become a second account-enumeration oracle (existing
      // accounts 500ing while nonexistent ones 201). Logged so a real
      // delivery failure is still visible to us, just not to the caller.
      this.logger.error('Failed to send password reset email', err instanceof Error ? err.stack : err);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });
    if (!user) {
      throw new BadRequestException('This reset link is invalid or has expired.');
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });
  }

  // Logs the user in on success -- the code itself is the proof of
  // identity here, the same way a Google profile is for oauthLogin, so
  // there's nothing else to separately re-authenticate.
  async verifyEmail(email: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (
      !user ||
      !user.emailVerificationCodeHash ||
      !user.emailVerificationExpiresAt ||
      user.emailVerificationExpiresAt < new Date() ||
      user.emailVerificationCodeHash !== hashCode(code)
    ) {
      throw new BadRequestException('That code is incorrect or has expired.');
    }

    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationCodeHash: null,
        emailVerificationExpiresAt: null,
      },
    });

    return this.buildAuthResponse(verified);
  }

  // Same non-enumeration posture as requestPasswordReset -- always
  // resolves the same way, failures logged rather than surfaced.
  async resendVerificationCode(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user || user.emailVerifiedAt) return;

    const code = generateVerificationCode();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationCodeHash: hashCode(code),
        emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    try {
      await this.emailService.sendVerificationEmail(user.email, code);
    } catch (err) {
      this.logger.error('Failed to resend verification email', err instanceof Error ? err.stack : err);
    }
  }

  private buildAuthResponse(user: {
    id: string;
    email: string;
    name: string;
    isAdmin: boolean;
  }) {
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      kind: 'candidate',
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.isAdmin,
      },
    };
  }
}
