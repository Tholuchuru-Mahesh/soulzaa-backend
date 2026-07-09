import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { OTP_SERVICE } from './interfaces/otp.interface';
import { OTP_QUEUES } from './otp.constants';
import { OtpMaintenanceProcessor } from './processors/otp-maintenance.processor';
import { OtpEmailProcessor } from './processors/otp-email.processor';
import { OtpSmsProcessor } from './processors/otp-sms.processor';
import { OtpRepository } from './repositories/otp.repository';
import { OtpProvider } from './services/otp.provider';
import { OtpScheduler } from './services/otp.scheduler';
import { OtpService } from './services/otp.service';
import { AwsSnsSmsProvider } from './services/providers/aws-sns-sms.provider';
import { ConsoleEmailProvider } from './services/providers/console-email.provider';
import { ConsoleSmsProvider } from './services/providers/console-sms.provider';
import { Msg91SmsProvider } from './services/providers/msg91-sms.provider';
import { SmsProviderRegistry } from './services/providers/sms-provider.registry';
import { TwilioSmsProvider } from './services/providers/twilio-sms.provider';

/**
 * OTP domain — generate / verify / resend one-time passwords with brute-force,
 * replay, duplicate-request and abuse protections; async multi-provider
 * delivery (Twilio/MSG91/AWS SNS/console) over dedicated BullMQ queues; and a
 * scheduled cleanup of the audit table.
 *
 * @Global so consumers (auth, future email/mobile-change flows) resolve
 * OTP_SERVICE by the interface token without importing this module — respecting
 * the boundary rule (cross-module access only via `interfaces/`). Registers its
 * own queues off the shared BullMQ connection from the global QueueModule.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: OTP_QUEUES.SMS },
      { name: OTP_QUEUES.EMAIL },
      { name: OTP_QUEUES.MAINTENANCE },
    ),
  ],
  providers: [
    OtpRepository,
    OtpService,
    OtpProvider,
    OtpScheduler,
    // Delivery providers + selection registry.
    SmsProviderRegistry,
    ConsoleSmsProvider,
    TwilioSmsProvider,
    Msg91SmsProvider,
    AwsSnsSmsProvider,
    ConsoleEmailProvider,
    // Queue workers.
    OtpSmsProcessor,
    OtpEmailProcessor,
    OtpMaintenanceProcessor,
    { provide: OTP_SERVICE, useExisting: OtpService },
  ],
  exports: [OTP_SERVICE],
})
export class OtpModule {}
