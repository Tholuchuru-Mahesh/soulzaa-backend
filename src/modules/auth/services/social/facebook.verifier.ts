import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { SocialIdentity } from '../../interfaces/social-identity-verifier.interface';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Shape of the `/debug_token` payload we actually rely on. */
interface DebugTokenData {
  app_id?: string;
  is_valid?: boolean;
  user_id?: string;
}

/** The `/me` fields requested. All optional — Facebook omits what it lacks. */
interface GraphProfile {
  id?: string;
  name?: string;
  email?: string;
}

/**
 * Verifies Facebook access tokens.
 *
 * Unlike Google and Apple, Facebook does not hand the client a signed JWT — the
 * Android SDK returns an opaque access token, so there is nothing to verify
 * offline. Trust therefore comes from asking Facebook directly:
 *
 *  1. `/debug_token` — is this token valid, and was it issued to *our* app? The
 *     app-id check is the security-critical half: without it, a token minted
 *     for any other Facebook app would authenticate here, letting that app's
 *     operator sign in as any of its users.
 *  2. `/me` — the profile fields the login needs.
 *
 * The app secret is required to build the app-token for step 1 and never leaves
 * the server; nothing about it is sent to or stored by the client.
 */
@Injectable()
export class FacebookVerifier {
  private readonly logger = new Logger(FacebookVerifier.name);
  private readonly appId: string | null;
  private readonly appSecret: string | null;

  constructor(config: ConfigService) {
    const social = config.get('social', { infer: true })!;
    this.appId = social.facebookAppId || null;
    this.appSecret = social.facebookAppSecret || null;
  }

  async verify(accessToken: string): Promise<SocialIdentity> {
    if (!this.appId || !this.appSecret) {
      throw this.reject('Facebook login is not configured');
    }

    const debug = await this.debugToken(accessToken);

    if (debug.is_valid !== true) {
      throw this.reject('Facebook rejected this access token');
    }
    // The check that makes the whole flow safe — see the class doc.
    if (debug.app_id !== this.appId) {
      this.logger.warn(
        `Rejected a Facebook token issued to app ${debug.app_id ?? 'unknown'}, not ours`,
      );
      throw this.reject('This Facebook token was not issued for this app');
    }

    const profile = await this.fetchProfile(accessToken);
    const providerUserId = profile.id ?? debug.user_id;
    if (!providerUserId) {
      throw this.reject('Facebook did not return a user id');
    }

    const email = profile.email && profile.email.length > 0 ? profile.email : null;

    return {
      provider: AuthProviderType.FACEBOOK,
      providerUserId,
      email,
      // Facebook only releases an address it has already confirmed, so its
      // presence is the verification. Absent is normal, not a failure: the
      // account may have none, or the user declined the permission.
      emailVerified: email !== null,
      name: profile.name ?? null,
    };
  }

  /**
   * Credentials go in the POST body rather than the query string — an
   * `access_token=<id>|<secret>` URL would otherwise be copied verbatim into
   * proxy and server access logs.
   */
  private async debugToken(accessToken: string): Promise<DebugTokenData> {
    const body = new URLSearchParams({
      input_token: accessToken,
      access_token: `${this.appId}|${this.appSecret}`,
    });

    const res = await this.call(`${GRAPH}/debug_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = (await res.json()) as { data?: DebugTokenData };
    return json.data ?? {};
  }

  private async fetchProfile(accessToken: string): Promise<GraphProfile> {
    const res = await this.call(`${GRAPH}/me?fields=id,name,email`, {
      // Bearer header, not a query param, for the same logging reason.
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return (await res.json()) as GraphProfile;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      // A Facebook outage is not the user's bad credentials; say so rather than
      // reporting their token as invalid.
      this.logger.error(`Facebook Graph unreachable: ${String(cause)}`);
      throw new BusinessException(
        ERROR_CODES.INVALID_SOCIAL_TOKEN,
        'Could not reach Facebook. Please try again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!res.ok) throw await this.explain(res);
    return res;
  }

  /**
   * Turns a Graph error into a message that says *whose* credentials failed.
   *
   * Both a wrong `FACEBOOK_APP_SECRET` and a junk user token make Graph answer
   * 400, and collapsing them into one "Facebook returned 400" hid a
   * misconfigured server behind what looked like an ordinary failed login. A
   * bad **signature** can only mean the app-token this server built is wrong,
   * because that is the only thing signed with the app secret — so it is the
   * one reliable tell that the fault is ours, not the user's.
   */
  private async explain(res: Response): Promise<BusinessException> {
    let fbMessage = '';
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: number } };
      fbMessage = body.error?.message ?? '';
    } catch {
      // Non-JSON error body — fall through to the generic message below.
    }

    const isOurCredentials = /signature/i.test(fbMessage);
    if (isOurCredentials) {
      // Operator-facing detail goes to the log, never to the client.
      this.logger.error(
        `Facebook rejected THIS SERVER's app credentials (${res.status}): ${fbMessage}. ` +
          'Check FACEBOOK_APP_ID / FACEBOOK_APP_SECRET.',
      );
      return this.reject('Facebook login is not accepted by Facebook for this app');
    }

    this.logger.warn(`Facebook rejected the user token (${res.status}): ${fbMessage}`);
    return this.reject('This Facebook sign-in could not be verified. Please try again.');
  }

  private reject(message: string): BusinessException {
    return new BusinessException(ERROR_CODES.INVALID_SOCIAL_TOKEN, message, HttpStatus.BAD_REQUEST);
  }
}
