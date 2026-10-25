import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterRecruiterDto } from './dto/register-recruiter.dto.js';
import { LoginRecruiterDto } from './dto/login-recruiter.dto.js';
import { verifyGoogleIdToken } from '../auth/google-id-token.js';

const PASSWORD_HASH_ROUNDS = 10;

@Injectable()
export class RecruiterAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

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
    const recruiter = await this.prisma.recruiter.create({
      data: {
        email,
        passwordHash,
        name: dto.name,
        companyName: dto.companyName,
      },
    });

    return this.buildAuthResponse(recruiter);
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

    return this.buildAuthResponse(recruiter);
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
    const recruiter = await this.prisma.recruiter.upsert({
      where: { email: normalizedEmail },
      update: {},
      create: { email: normalizedEmail, name: identity.name },
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
