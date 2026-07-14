import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import {
  PushTokenInvalidError,
  type IPushProvider,
  type PushMessage,
  type PushProviderName,
} from '../../../interfaces/push-provider.interface';

/**
 * Name of this provider's firebase-admin app. Named rather than default so it
 * cannot collide with the app the auth module initialises for phone verification.
 */
const FCM_APP_NAME = 'soulzaa-push';

/**
 * FCM error codes that mean "this token is dead", as opposed to "this send
 * failed". Only these retire a token — a transient `messaging/server-unavailable`
 * must never cost a user their push registration.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Firebase Cloud Messaging transport.
 *
 * ## Why the payload is asymmetric
 *
 * The top-level `notification` block is deliberately **absent**. When it is
 * present, Android hands the message straight to the system tray and the app
 * never sees it while backgrounded — which means the notification cannot be
 * localised, cannot be grouped by conversation, cannot be placed on the channel
 * the user's sound/vibration preferences chose, and cannot be cancelled when the
 * message is read on another device. Sending Android a *data-only* message wakes
 * the client's background isolate, which builds the notification itself and gets
 * all four back.
 *
 * iOS cannot use that trick: a data-only push is a background wake, which Apple
 * throttles and drops outright once the app is terminated. So iOS gets a real
 * alert, assembled in the `apns` block.
 *
 * One message, two presentations — which is exactly what the two platforms are.
 */
@Injectable()
export class FcmPushProvider implements IPushProvider, OnModuleInit {
  readonly name: PushProviderName = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly creds: { projectId?: string; clientEmail?: string; privateKey?: string };
  private app?: App;

  constructor(config: ConfigService) {
    this.creds = config.get<{
      fcm: { projectId?: string; clientEmail?: string; privateKey?: string };
    }>('pushProviders', { infer: true })!.fcm;
  }

  onModuleInit(): void {
    const { projectId, clientEmail, privateKey } = this.creds;
    if (!projectId || !clientEmail || !privateKey) {
      // Not fatal: this provider is only selected when PUSH_PROVIDER=fcm, and
      // send() names the missing variables precisely if it ever is.
      this.logger.warn('FCM credentials absent — the fcm push provider is inert');
      return;
    }
    const existing = getApps().find((a) => a.name === FCM_APP_NAME);
    this.app =
      existing ??
      initializeApp(
        {
          credential: cert({
            projectId,
            clientEmail,
            // Env vars cannot carry real newlines, so the PEM is stored escaped.
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        },
        FCM_APP_NAME,
      );
    this.logger.log(`FCM push provider ready (project ${projectId})`);
  }

  async send(token: string, message: PushMessage): Promise<void> {
    if (!this.app) {
      throw new Error(
        'FCM push provider is not configured (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY)',
      );
    }

    const highPriority = message.priority === 'high';
    const { ttlSeconds, collapseKey, threadId, badge } = message;

    try {
      await getMessaging(this.app).send({
        token,
        // Everything the Android client needs in order to *build* the notification
        // travels here, because on Android the client is what builds it. FCM data
        // values are strings — no exceptions, no numbers.
        data: {
          ...message.data,
          title: message.title,
          body: message.body,
          category: message.category,
          channelId: message.channelId,
          ...(threadId ? { threadId } : {}),
          ...(badge !== undefined ? { badge: String(badge) } : {}),
        },
        android: {
          priority: highPriority ? 'high' : 'normal',
          ...(ttlSeconds !== undefined ? { ttl: ttlSeconds * 1000 } : {}),
          ...(collapseKey ? { collapseKey } : {}),
        },
        apns: {
          headers: {
            'apns-priority': highPriority ? '10' : '5',
            // This push carries a user-visible alert. Saying so is mandatory on
            // iOS 13+; APNs rejects an alert payload announced as a background one.
            'apns-push-type': 'alert',
            ...(ttlSeconds !== undefined
              ? { 'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSeconds) }
              : {}),
            ...(collapseKey ? { 'apns-collapse-id': collapseKey } : {}),
          },
          payload: {
            aps: {
              alert: { title: message.title, body: message.body },
              ...(message.sound === false ? {} : { sound: 'default' }),
              ...(badge !== undefined ? { badge } : {}),
              // Groups the banner with the rest of its conversation in Notification
              // Centre, instead of stacking ten separate cards for one chat.
              ...(threadId ? { threadId } : {}),
              // Wake the app on arrival so it can raise its own UI (the incoming-call
              // screen) rather than only drawing a system banner.
              contentAvailable: true,
            },
          },
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (DEAD_TOKEN_CODES.has(code)) throw new PushTokenInvalidError(token, code);
      throw err;
    }
  }
}
