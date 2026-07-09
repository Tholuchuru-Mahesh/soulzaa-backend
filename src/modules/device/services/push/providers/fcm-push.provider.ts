import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IPushProvider,
  PushMessage,
  PushProviderName,
} from '../../../interfaces/push-provider.interface';

/**
 * Firebase Cloud Messaging transport — SCAFFOLD. Credentials come from the
 * `pushProviders.fcm` config namespace. To activate:
 *   1) `pnpm add firebase-admin`
 *   2) initialise once: admin.initializeApp({ credential: admin.credential.cert({
 *        projectId, clientEmail, privateKey }) })
 *   3) replace send() with:
 *        await admin.messaging().send({ token, notification: { title, body }, data });
 * Logs until then so the flow is exercisable without Firebase credentials.
 */
@Injectable()
export class FcmPushProvider implements IPushProvider {
  readonly name: PushProviderName = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly projectId?: string;

  constructor(config: ConfigService) {
    this.projectId = config.get('pushProviders', { infer: true })!.fcm.projectId;
  }

  async send(token: string, message: PushMessage): Promise<void> {
    if (!this.projectId) {
      this.logger.error('FCM not configured (FCM_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY)');
      throw new Error('FCM push provider is not configured');
    }
    // TODO: integrate firebase-admin messaging — see class doc.
    this.logger.warn(`[fcm stub] would push to ${token.slice(0, 12)}…: ${message.title}`);
  }
}
