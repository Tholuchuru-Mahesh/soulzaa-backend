import { Injectable, Logger } from '@nestjs/common';
import type { EmailProviderName, IEmailProvider } from '../../interfaces/email-provider.interface';

/**
 * Default email transport: logs the message. Swap OTP_EMAIL_PROVIDER=smtp and
 * bind an SES/SMTP implementation for production.
 */
@Injectable()
export class ConsoleEmailProvider implements IEmailProvider {
  readonly name: EmailProviderName = 'console';
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(to: string, subject: string, body: string): Promise<void> {
    this.logger.warn(`[DEV EMAIL] → ${to} | ${subject}: ${body}`);
  }
}
