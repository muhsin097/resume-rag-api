import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface RecruiterJwtPayload {
  sub: string;
  email: string;
  kind: 'recruiter';
}

// Registered under its own Passport strategy name ('jwt-recruiter') so it
// can be wired into a separate guard from the candidate JwtStrategy's
// 'jwt'. The strategy name alone doesn't stop a candidate's token from
// verifying here too -- both share JWT_SECRET -- so validate() explicitly
// rejects anything without the recruiter `kind` claim.
@Injectable()
export class RecruiterJwtStrategy extends PassportStrategy(
  Strategy,
  'jwt-recruiter',
) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: RecruiterJwtPayload) {
    if (payload.kind !== 'recruiter') {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email };
  }
}
