import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';

/**
 * Twilio SMS transport — SCAFFOLD. Reads credentials from the `otpProviders`
 * config namespace. To activate:
 *   1) `pnpm add twilio`
 *   2) replace the body of send() with:
 *        const client = twilio(sid, token);
 *        await client.messages.create({ to, from: this.from, body: message });
 * Until then it logs so the flow is exercisable without a Twilio account.
 */
@Injectable()
export class TwilioSmsProvider implements ISmsProvider {
  readonly name: SmsProviderName = 'twilio';
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly from?: string;

  constructor(config: ConfigService) {
    const cfg = config.get('otpProviders', { infer: true })!.twilio;
    this.accountSid = cfg.accountSid;
    this.authToken = cfg.authToken;
    this.from = cfg.fromNumber;
  }

  async send(to: string, message: string): Promise<void> {
    if (!this.accountSid || !this.authToken || !this.from) {
      this.logger.error('Twilio not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER)');
      throw new Error('Twilio SMS provider is not configured');
    }
    // TODO: integrate the twilio SDK — see class doc.
    this.logger.warn(`[twilio stub] would send SMS to ${to}: ${message}`);
  }
}
