import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';

/**
 * MSG91 SMS transport — SCAFFOLD. MSG91 is a plain HTTPS API (no SDK needed);
 * to activate, replace send() with a fetch to
 *   https://api.msg91.com/api/v5/flow/  (or /sendhttp)
 * using authKey + senderId from the `otpProviders` config. Logs until then.
 */
@Injectable()
export class Msg91SmsProvider implements ISmsProvider {
  readonly name: SmsProviderName = 'msg91';
  private readonly logger = new Logger(Msg91SmsProvider.name);
  private readonly authKey?: string;
  private readonly senderId?: string;

  constructor(config: ConfigService) {
    const cfg = config.get('otpProviders', { infer: true })!.msg91;
    this.authKey = cfg.authKey;
    this.senderId = cfg.senderId;
  }

  async send(to: string, message: string): Promise<void> {
    if (!this.authKey || !this.senderId) {
      this.logger.error('MSG91 not configured (MSG91_AUTH_KEY/MSG91_SENDER_ID)');
      throw new Error('MSG91 SMS provider is not configured');
    }
    // TODO: POST to the MSG91 API — see class doc.
    this.logger.warn(`[msg91 stub] would send SMS to ${to}: ${message}`);
  }
}
