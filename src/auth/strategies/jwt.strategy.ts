import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  // Absent on tokens issued before this field existed -- treated as 0
  // below, which matches every pre-existing row's default.
  tokenVersion?: number;
  kind?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  // A token is valid for 7 days, but isAdmin (hand-flipped in the DB, no
  // revoke endpoint) and account deletion both used to only take effect
  // the NEXT time the holder actually logged in -- an admin demoted by
  // hand, or an account deleted via deleteAccount(), kept working at
  // their old privilege level for up to 7 more days on an
  // already-issued token. This now re-reads the live row on every
  // request instead of trusting the embedded claims for any of that.
  async validate(payload: JwtPayload) {
    // Tokens issued before the recruiter side existed have no `kind` claim
    // at all -- only ever reject an *explicit* recruiter token here, so
    // those older candidate sessions keep working.
    if (payload.kind === 'recruiter') {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, isAdmin: true, deletedAt: true, tokenVersion: true },
    });
    if (!user || user.deletedAt || user.tokenVersion !== (payload.tokenVersion ?? 0)) {
      throw new UnauthorizedException();
    }

    return { id: user.id, email: user.email, isAdmin: user.isAdmin };
  }
}
