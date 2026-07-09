import { Injectable, Logger } from '@nestjs/common';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';

/**
 * Default SMS transport: logs the message. Never enabled in production (codes
 * must not be logged). Swap OTP_SMS_PROVIDER to twilio/msg91/aws_sns there.
 */
@Injectable()
export class ConsoleSmsProvider implements ISmsProvider {
  readonly name: SmsProviderName = 'console';
  private readonly logger = new Logger(ConsoleSmsProvider.name);

  async send(to: string, message: string): Promise<void> {
    this.logger.warn(`[DEV SMS] → ${to}: ${message}`);
  }
}
