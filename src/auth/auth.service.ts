import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';

const PASSWORD_HASH_ROUNDS = 10;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

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
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, name: dto.name },
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    // No passwordHash means this account was created via Google OAuth --
    // there's nothing to compare against, so reject cleanly rather than
    // let bcrypt.compare throw on a null hash.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResponse(user);
  }

  // Called from resume-rag-web's NextAuth jwt callback after Google has
  // already verified the email -- never reachable from outside the compose
  // network (api has no public port), so there's no path for an outside
  // caller to assert an arbitrary email here.
  async oauthLogin(email: string, name: string) {
    const normalizedEmail = email.toLowerCase();
    const user = await this.prisma.user.upsert({
      where: { email: normalizedEmail },
      update: {},
      create: { email: normalizedEmail, name },
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
