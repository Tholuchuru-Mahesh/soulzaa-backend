import { ConfigService } from '@nestjs/config';
import { BusinessException } from 'src/common/exceptions';
import { FacebookVerifier } from './facebook.verifier';

/**
 * Facebook is the odd one out among the social providers: Google and Apple hand
 * us a signed JWT we can verify offline, while Facebook returns an opaque
 * access token. The only way to trust it is to ask Facebook — first whether the
 * token was issued for *our* app (`/debug_token`, which is what stops a token
 * minted for someone else's app being replayed here), then who it belongs to.
 */
describe('FacebookVerifier', () => {
  const APP_ID = '2479984402521329';
  const SECRET = 'server-side-only-secret';

  const config = (appId: string | null = APP_ID, secret: string | null = SECRET) =>
    ({
      get: () => ({ facebookAppId: appId, facebookAppSecret: secret }),
    }) as unknown as ConfigService;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.restoreAllMocks());

  const debugOk = (appId: string = APP_ID) => ({
    ok: true,
    json: async () => ({ data: { app_id: appId, is_valid: true, user_id: 'fb-user-1' } }),
  });

  const profile = (over: Record<string, unknown> = {}) => ({
    ok: true,
    json: async () => ({ id: 'fb-user-1', name: 'Vasu', email: 'vasu@example.com', ...over }),
  });

  it('returns the verified identity for a token issued to this app', async () => {
    fetchMock.mockResolvedValueOnce(debugOk()).mockResolvedValueOnce(profile());

    const identity = await new FacebookVerifier(config()).verify('tok');

    expect(identity).toEqual({
      provider: 'FACEBOOK',
      providerUserId: 'fb-user-1',
      email: 'vasu@example.com',
      // Facebook only returns an address once it has confirmed it.
      emailVerified: true,
      name: 'Vasu',
    });
  });

  it('rejects a token minted for a different app', async () => {
    fetchMock.mockResolvedValueOnce(debugOk('9999999999')).mockResolvedValueOnce(profile());

    await expect(new FacebookVerifier(config()).verify('tok')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('rejects a token Facebook reports as invalid', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { app_id: APP_ID, is_valid: false } }),
    });

    await expect(new FacebookVerifier(config()).verify('tok')).rejects.toBeInstanceOf(
      BusinessException,
    );
  });

  it('treats a missing email as absent rather than failing the login', async () => {
    // A Facebook account can have no address, or the user can decline the
    // permission. Neither is an authentication failure — profile completion
    // asks for it later.
    fetchMock.mockResolvedValueOnce(debugOk()).mockResolvedValueOnce(profile({ email: undefined }));

    const identity = await new FacebookVerifier(config()).verify('tok');

    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
    expect(identity.providerUserId).toBe('fb-user-1');
  });

  it('refuses to run at all when the app is not configured', async () => {
    await expect(new FacebookVerifier(config(null, null)).verify('tok')).rejects.toBeInstanceOf(
      BusinessException,
    );
    // Nothing must reach Facebook without credentials.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says plainly when it is OUR credentials Facebook rejected, not the user token', async () => {
    // The distinction this pins down cost three rounds of debugging in
    // production: a wrong FACEBOOK_APP_SECRET and a junk user token both made
    // Graph answer 400, and both surfaced as the same "Facebook returned 400".
    // One is an operator misconfiguration, the other is a normal bad login.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 190, message: 'Invalid OAuth access token signature.' },
      }),
    });

    await expect(new FacebookVerifier(config()).verify('tok')).rejects.toThrow(
      /not accepted by Facebook/i,
    );
  });

  it('reports a bad user token as a bad user token', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: { code: 190, message: 'Invalid OAuth 2.0 Access Token' },
      }),
    });

    await expect(new FacebookVerifier(config()).verify('tok')).rejects.toThrow(
      /sign-in could not be verified/i,
    );
  });

  it('calls /debug_token with GET — Graph rejects a POST there', async () => {
    // Production failure: the endpoint answered
    //   "Unsupported post request. Please read the Graph API documentation"
    // for every login, because /debug_token is GET-only. It surfaced as a token
    // error, which is exactly what it was not.
    fetchMock.mockResolvedValueOnce(debugOk()).mockResolvedValueOnce(profile());

    await new FacebookVerifier(config()).verify('tok');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toContain('/debug_token');
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('never puts the app secret in the token-debug query string', async () => {
    fetchMock.mockResolvedValueOnce(debugOk()).mockResolvedValueOnce(profile());

    await new FacebookVerifier(config()).verify('tok');

    // `access_token=<id>|<secret>` in a URL ends up in proxy and server logs.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    for (const url of urls) {
      expect(url).not.toContain(SECRET);
    }
  });
});
