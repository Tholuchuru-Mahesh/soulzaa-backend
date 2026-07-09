import { Injectable } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { SmsProviderRegistry } from './providers/sms-provider.registry';

/**
 * Delivery facade for OTP codes. Chooses SMS vs email by channel and routes to
 * the configured transport (via SmsProviderRegistry / the email provider). The
 * queue processors call this; OtpService never touches a provider directly.
 * Returns the transport name for the `otp.sent` event.
 */
@Injectable()
export class OtpProvider {
  constructor(
    private readonly sms: SmsProviderRegistry,
    private readonly email: ConsoleEmailProvider,
  ) {}

  async deliver(channel: OtpChannel, destination: string, code: string): Promise<string> {
    if (channel === OtpChannel.EMAIL) {
      await this.email.send(destination, 'Your Soulzaa verification code', this.emailBody(code));
      return this.email.name;
    }
    const provider = this.sms.resolve();
    await provider.send(destination, this.smsBody(code));
    return provider.name;
  }

  private smsBody(code: string): string {
    return `Your Soulzaa verification code is ${code}. Do not share it with anyone.`;
  }

  private emailBody(code: string): string {
    return `Your Soulzaa verification code is ${code}. It expires shortly. Do not share it.`;
  }
}
