import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';
import { AwsSnsSmsProvider } from './aws-sns-sms.provider';
import { ConsoleSmsProvider } from './console-sms.provider';
import { Msg91SmsProvider } from './msg91-sms.provider';
import { TwilioSmsProvider } from './twilio-sms.provider';

/**
 * Selects the active SMS transport from OTP_SMS_PROVIDER. Every provider is
 * instantiated (cheap — they only read config); the registry hands out the one
 * named in config, defaulting to console. This is the seam that keeps provider
 * SDKs out of OtpService and makes provider selection unit-testable.
 */
@Injectable()
export class SmsProviderRegistry {
  private readonly providers: Record<SmsProviderName, ISmsProvider>;
  private readonly selected: SmsProviderName;

  constructor(
    config: ConfigService,
    console: ConsoleSmsProvider,
    twilio: TwilioSmsProvider,
    msg91: Msg91SmsProvider,
    awsSns: AwsSnsSmsProvider,
  ) {
    this.providers = { console, twilio, msg91, aws_sns: awsSns };
    this.selected = config.get('otp', { infer: true })!.smsProvider;
  }

  resolve(): ISmsProvider {
    return this.providers[this.selected] ?? this.providers.console;
  }
}
