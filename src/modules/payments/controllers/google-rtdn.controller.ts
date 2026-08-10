import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Headers,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { OAuth2Client } from 'google-auth-library';
import { Public } from 'src/common/decorators/public.decorator';
import { DeveloperNotification, PubSubPushDto } from '../dto/google-rtdn.dto';
import { GoogleRtdnService } from '../services/google-rtdn.service';

/** Uniform 401 body — never leaks which check failed (missing token vs.
 * unconfigured audience vs. wrong principal), so an attacker probing the
 * endpoint learns nothing about its configuration state. The real reason is
 * always in the server-side log. */
const UNAUTHORIZED_MESSAGE = 'Unauthorized';

/**
 * Pub/Sub push target for Play's real-time developer notifications.
 *
 * Marked `@Public()` — `JwtAuthGuard` is a global `APP_GUARD`, and Google cannot
 * present a Soulzaa JWT, so this route is exempted from it the same way the
 * pre-auth routes in `auth.controller.ts` are. `@Public()` only opts this route
 * out of the JWT guard; it is still authenticated, just by a different
 * mechanism: `assertGenuinePush` verifies the OIDC token Pub/Sub attaches to
 * the push (signature, issuer, audience, and — critically — that it was minted
 * by the configured Pub/Sub service account, not merely by *some* Google
 * account), so an anonymous POST still cannot fabricate a refund and drive a
 * wallet negative.
 */
@ApiTags('Coin Purchase & Payments')
@Controller('payments/webhooks')
export class GoogleRtdnController {
  private readonly logger = new Logger(GoogleRtdnController.name);
  private readonly oauthClient = new OAuth2Client();

  constructor(
    private readonly rtdnService: GoogleRtdnService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @ApiExcludeEndpoint()
  @Post('google-rtdn')
  @HttpCode(HttpStatus.OK)
  async handlePush(@Body() body: PubSubPushDto, @Headers('authorization') authorization?: string) {
    await this.assertGenuinePush(authorization);

    const encoded = body?.message?.data;
    if (!encoded) {
      // Well-formed but empty. 200 so Pub/Sub stops rather than retrying forever.
      this.logger.warn('RTDN push had no message data');
      return { received: true, handled: false };
    }

    let notification: DeveloperNotification;
    try {
      notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      this.logger.warn('RTDN push data was not base64 JSON');
      return { received: true, handled: false };
    }

    // Anything the service throws (economy freeze, DB error) is deliberately
    // NOT caught here — it must escape as a non-2xx so Pub/Sub retries. Only
    // notifications we understand but cannot act on resolve to `{handled:false}`.
    const result = await this.rtdnService.handleNotification(notification);
    return { received: true, handled: result.handled };
  }

  private async assertGenuinePush(authorization?: string): Promise<void> {
    const payments = this.config.get('payments', { infer: true });
    const audience = payments?.googleRtdnPushAudience;
    const expectedEmail = payments?.googleRtdnServiceAccountEmail;

    if (!audience || !expectedEmail) {
      // Fail closed: an unconfigured webhook must not accept anonymous refunds.
      this.logger.warn(
        'RTDN webhook rejected: googleRtdnPushAudience or googleRtdnServiceAccountEmail is unset',
      );
      throw new UnauthorizedException(UNAUTHORIZED_MESSAGE);
    }

    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) {
      this.logger.warn('RTDN webhook rejected: missing bearer token');
      throw new UnauthorizedException(UNAUTHORIZED_MESSAGE);
    }

    let payload;
    try {
      const ticket = await this.oauthClient.verifyIdToken({ idToken: token, audience });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(
        `RTDN webhook rejected: token failed OIDC verification (${(err as Error).message})`,
      );
      throw new UnauthorizedException(UNAUTHORIZED_MESSAGE);
    }

    // `verifyIdToken` only proves the token is genuinely Google-signed, not
    // expired, and issued for our audience — but the audience is a public,
    // guessable URL, and ANY Google account in ANY GCP project can mint a
    // token for it. The principal check below is what actually restricts this
    // to "our Pub/Sub subscription," not "anyone with a Google account."
    if (!payload?.email_verified || payload.email !== expectedEmail) {
      this.logger.warn(
        `RTDN webhook rejected: unexpected token principal '${payload?.email ?? 'unknown'}'`,
      );
      throw new UnauthorizedException(UNAUTHORIZED_MESSAGE);
    }
  }
}
