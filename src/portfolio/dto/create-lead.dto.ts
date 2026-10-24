import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

// Public, unauthenticated -- this is the VISITOR's own contact info
// (whoever clicked "interested" on a shared portfolio link), not the
// portfolio owner's. Name/message are optional specifically to keep the
// form to one required field; see PortfolioService for the dedupe and
// rate-limit protections this needs given anyone can hit this endpoint.
export class CreateLeadDto {
  @IsEmail()
  @MaxLength(254)
  visitorEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  visitorName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
