import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  kind?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload) {
    // Tokens issued before the recruiter side existed have no `kind` claim
    // at all -- only ever reject an *explicit* recruiter token here, so
    // those older candidate sessions keep working.
    if (payload.kind === 'recruiter') {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email, isAdmin: payload.isAdmin };
  }
}
