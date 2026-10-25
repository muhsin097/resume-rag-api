import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

// This is the fix for a real, confirmed vulnerability: /auth/oauth and
// /recruiter-auth/oauth used to accept a raw {email, name} from the
// request body and issue a real JWT for that email with zero proof --
// reproduced locally, a plain POST with any existing user's email
// returned a valid access token, no Google involvement at all. These
// tests cover the verification function that closes that hole.
const mockVerifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  // google-id-token.ts calls `new OAuth2Client(...)` -- the mock
  // implementation must be a real `function` (not an arrow function) so
  // it can be used as a constructor; an arrow-function implementation
  // can't be `new`-ed and silently produces a broken instance.
  OAuth2Client: vi.fn().mockImplementation(function () {
    return { verifyIdToken: mockVerifyIdToken };
  }),
}));

const { verifyGoogleIdToken } = await import('./google-id-token.js');

describe('verifyGoogleIdToken', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
    mockVerifyIdToken.mockReset();
  });

  it('returns the verified identity for a token with a verified email', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'real@example.com', email_verified: true, name: 'Real Person' }),
    });

    const identity = await verifyGoogleIdToken('valid-token');
    expect(identity).toEqual({ email: 'real@example.com', name: 'Real Person' });
  });

  // The actual exploit this closes: google-auth-library's verifyIdToken
  // itself rejects a forged/garbage token, a token signed for a
  // different Google OAuth client (wrong audience), or an expired one --
  // this test stands in for that real rejection without needing an
  // actual Google-signed token in CI.
  it('rejects when Google verification itself throws (bad signature/audience/expiry)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));

    await expect(verifyGoogleIdToken('forged-token')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an unverified email even if the token itself is cryptographically valid', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'unverified@example.com', email_verified: false, name: 'Someone' }),
    });

    await expect(verifyGoogleIdToken('token-with-unverified-email')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when there is no payload at all', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => undefined });

    await expect(verifyGoogleIdToken('weird-token')).rejects.toThrow(UnauthorizedException);
  });

  it('falls back to the email as the name when Google does not provide one', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'noname@example.com', email_verified: true }),
    });

    const identity = await verifyGoogleIdToken('token');
    expect(identity.name).toBe('noname@example.com');
  });

  // Confirms the audience actually gets passed through -- without this,
  // a token minted for a COMPLETELY different Google OAuth app could
  // pass verification as long as its signature/issuer/expiry checked
  // out, which isn't proof of anything about THIS app.
  it('passes the configured GOOGLE_CLIENT_ID as the required audience', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'real@example.com', email_verified: true, name: 'Real Person' }),
    });

    await verifyGoogleIdToken('valid-token');

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'test-client-id.apps.googleusercontent.com' }),
    );
  });
});
