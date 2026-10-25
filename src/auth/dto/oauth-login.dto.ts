import { IsString, MinLength } from 'class-validator';

// Replaces the old {email, name} shape -- that let anyone claim any
// email with zero proof. The actual Google ID token is the only thing
// accepted now; email/name are derived from its verified payload
// server-side, never trusted from client input. See google-id-token.ts.
export class OAuthLoginDto {
  @IsString()
  @MinLength(1)
  idToken!: string;
}
