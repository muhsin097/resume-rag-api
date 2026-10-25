import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

let client: OAuth2Client | null = null;

function getClient(clientId: string): OAuth2Client {
  if (!client) {
    client = new OAuth2Client(clientId);
  }
  return client;
}

export interface VerifiedGoogleIdentity {
  email: string;
  name: string;
}

// The fix for a real, confirmed vulnerability: the old /auth/oauth and
// /recruiter-auth/oauth endpoints took a raw {email, name} from the
// request body and issued a real JWT for that email with zero proof the
// caller had actually authenticated with Google -- reproduced locally,
// a plain POST with any existing user's email returned a valid access
// token, no password or Google involvement at all.
//
// This verifies the actual Google-issued ID token server-side:
// signature (against Google's published public keys), issuer, audience
// (must be THIS app's own OAuth client -- not just any valid Google
// token from a different app), and expiry are all checked inside
// verifyIdToken() itself. email_verified is checked separately --
// Google will happily include an email Google itself hasn't confirmed.
// The caller must use the email/name from the RETURNED verified
// identity, never from a separately-supplied request field -- that's
// what closes the "any email you like" hole, not just "some token must
// be present".
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID is not configured');
  }

  let payload;
  try {
    const ticket = await getClient(clientId).verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    throw new UnauthorizedException('Invalid Google sign-in token.');
  }

  if (!payload?.email || !payload.email_verified) {
    throw new UnauthorizedException('Google did not provide a verified email for this sign-in.');
  }

  return { email: payload.email, name: payload.name ?? payload.email };
}
