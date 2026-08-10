import { Reflector } from '@nestjs/core';
import { OAuth2Client } from 'google-auth-library';
import { IS_PUBLIC_KEY } from 'src/common/constants';
import { GoogleRtdnController } from './google-rtdn.controller';

/**
 * This endpoint sits outside JwtAuthGuard (via `@Public()`) because Google
 * cannot present a Soulzaa JWT — the OIDC token check in `assertGenuinePush`
 * *is* the security boundary. Every test that expects a 401 spies on
 * `verifyIdToken` up front and asserts either that it was never reached
 * (fail-fast checks) or that it was reached but produced a rejection
 * (token/principal checks) — so no test in this file is ever capable of making
 * a real network call. That distinction matters: a test that silently falls
 * through to the real, unmocked `verifyIdToken` still "passes" (it rejects
 * into the same UnauthorizedException the assertion checks) while testing
 * nothing at all.
 */
describe('GoogleRtdnController', () => {
  const AUDIENCE = 'https://api.soulzaa.com/payments/webhooks/google-rtdn';
  const SERVICE_ACCOUNT_EMAIL = 'rtdn-pusher@soulzaa-project.iam.gserviceaccount.com';

  type BuildConfig = { audience?: string; expectedEmail?: string };

  // No default parameter values here on purpose — a default substitutes for an
  // explicitly-passed `undefined` too, which would defeat the tests below that
  // need to pass "unconfigured" through as a real `undefined`. Every call site
  // states its config explicitly instead.
  const build = ({ audience, expectedEmail }: BuildConfig) => {
    const handleNotification = jest.fn().mockResolvedValue({ handled: true });
    const rtdnService = { handleNotification } as any;
    const config = {
      get: jest.fn().mockReturnValue({
        googleRtdnPushAudience: audience,
        googleRtdnServiceAccountEmail: expectedEmail,
      }),
    } as any;
    const controller = new GoogleRtdnController(rtdnService, config);
    return { controller, handleNotification, config };
  };

  const bodyFor = (notification: Record<string, unknown>) => ({
    message: { data: Buffer.from(JSON.stringify(notification)).toString('base64') },
  });

  // `verifyIdToken` is overloaded (promise vs. callback form), which makes jest's
  // inferred mock type collapse to `never`. Cast the spy itself, not each call.
  //
  // `jest.spyOn` calls through to the REAL implementation by default (this
  // project's jest config sets neither `restoreMocks` nor `resetMocks`), so a
  // bare spy with no default here would let a test whose guard regressed fall
  // through to a live network call to Google — and still "pass" once that call
  // rejects into the same exception the assertion checks. The default below
  // makes that impossible: any call that isn't explicitly overridden with
  // `mockResolvedValue`/`mockRejectedValue` fails immediately, in-process, with
  // a message that can only come from this test double.
  const spyOnVerifyIdToken = () =>
    (jest.spyOn(OAuth2Client.prototype, 'verifyIdToken') as unknown as jest.Mock).mockRejectedValue(
      new Error('verifyIdToken must not be called in this test'),
    );

  const validTicket = (overrides: Record<string, unknown> = {}) => ({
    getPayload: () => ({ email_verified: true, email: SERVICE_ACCOUNT_EMAIL, ...overrides }),
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is marked @Public() so the global JwtAuthGuard does not reject every genuine Google push before it ever reaches this code', () => {
    const isPublic = new Reflector().get<boolean>(
      IS_PUBLIC_KEY,
      GoogleRtdnController.prototype.handlePush,
    );
    expect(isPublic).toBe(true);
  });

  it('rejects a request with no Authorization header with 401, never calls verifyIdToken, and never calls the service', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    const verifyIdToken = spyOnVerifyIdToken();

    await expect(controller.handlePush(bodyFor({}) as any, undefined)).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('rejects with 401 when googleRtdnPushAudience is unconfigured, even with a bearer token present, and never calls verifyIdToken', async () => {
    const { controller, handleNotification } = build({
      audience: undefined,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    const verifyIdToken = spyOnVerifyIdToken();

    await expect(
      controller.handlePush(bodyFor({}) as any, 'Bearer some-token'),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('rejects with 401 when googleRtdnServiceAccountEmail is unconfigured, even with a bearer token present, and never calls verifyIdToken', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: undefined,
    });
    const verifyIdToken = spyOnVerifyIdToken();

    await expect(
      controller.handlePush(bodyFor({}) as any, 'Bearer some-token'),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the bearer token fails OIDC verification', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    const verifyIdToken = spyOnVerifyIdToken();
    verifyIdToken.mockRejectedValue(new Error('bad signature'));

    await expect(controller.handlePush(bodyFor({}) as any, 'Bearer garbage')).rejects.toMatchObject(
      {
        status: 401,
        message: 'Unauthorized',
      },
    );
    expect(verifyIdToken).toHaveBeenCalled();
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is genuinely Google-signed but minted by the wrong principal', async () => {
    // The scenario Important-4 exists for: ANY Google account can mint a token
    // for our (public, guessable) audience URL. Signature/audience verification
    // alone is not enough — the email claim must match the configured pusher.
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    const verifyIdToken = spyOnVerifyIdToken();
    verifyIdToken.mockResolvedValue(validTicket({ email: 'someone-else@gmail.com' }));

    await expect(
      controller.handlePush(bodyFor({}) as any, 'Bearer someone-elses-valid-token'),
    ).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token email is not verified, even if it matches the configured address', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    const verifyIdToken = spyOnVerifyIdToken();
    verifyIdToken.mockResolvedValue(validTicket({ email_verified: false }));

    await expect(
      controller.handlePush(bodyFor({}) as any, 'Bearer unverified-token'),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('returns 200 with handled:false for a valid token and an unknown/unactionable purchase', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    spyOnVerifyIdToken().mockResolvedValue(validTicket());
    handleNotification.mockResolvedValue({ handled: false });

    const result = await controller.handlePush(
      bodyFor({
        voidedPurchaseNotification: { purchaseToken: 'tok', orderId: 'GPA.unknown' },
      }) as any,
      'Bearer good-token',
    );

    expect(result).toEqual({ received: true, handled: false });
  });

  it('returns 200 with handled:true for a valid token and a completed order', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    spyOnVerifyIdToken().mockResolvedValue(validTicket());
    handleNotification.mockResolvedValue({ handled: true });

    const result = await controller.handlePush(
      bodyFor({ voidedPurchaseNotification: { purchaseToken: 'tok', orderId: 'GPA.1' } }) as any,
      'Bearer good-token',
    );

    expect(result).toEqual({ received: true, handled: true });
  });

  it('returns 200 with handled:false rather than throwing when the push has no message data', async () => {
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    spyOnVerifyIdToken().mockResolvedValue(validTicket());

    const result = await controller.handlePush({ message: {} } as any, 'Bearer good-token');

    expect(result).toEqual({ received: true, handled: false });
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('lets a genuine service failure (economy freeze, DB error) escape rather than swallowing it into a 200', async () => {
    // The 200 rule is only for notifications we understand but cannot act on
    // (unknown token, non-COMPLETED order, unhandled type). A transient failure
    // must escape as non-2xx so Pub/Sub retries — silently answering 200 here
    // would drop a real refund on the floor.
    const { controller, handleNotification } = build({
      audience: AUDIENCE,
      expectedEmail: SERVICE_ACCOUNT_EMAIL,
    });
    spyOnVerifyIdToken().mockResolvedValue(validTicket());
    handleNotification.mockRejectedValue(new Error('economy frozen'));

    await expect(
      controller.handlePush(
        bodyFor({ voidedPurchaseNotification: { purchaseToken: 'tok', orderId: 'GPA.1' } }) as any,
        'Bearer good-token',
      ),
    ).rejects.toThrow('economy frozen');
  });
});
