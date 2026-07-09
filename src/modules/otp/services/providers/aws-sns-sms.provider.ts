import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';

/**
 * AWS SNS SMS transport — SCAFFOLD. The AWS SDK (@aws-sdk/client-sns) is not a
 * dependency yet; @aws-sdk/client-s3 already is, so adding SNS is cheap. To
 * activate, replace send() with:
 *   const sns = new SNSClient({ region, credentials });
 *   await sns.send(new PublishCommand({ PhoneNumber: to, Message: message }));
 * Reuses the platform AWS credentials (region + access keys). Logs until then.
 */
@Injectable()
export class AwsSnsSmsProvider implements ISmsProvider {
  readonly name: SmsProviderName = 'aws_sns';
  private readonly logger = new Logger(AwsSnsSmsProvider.name);
  private readonly region: string;

  constructor(config: ConfigService) {
    this.region = config.get('otpProviders', { infer: true })!.awsSns.region;
  }

  async send(to: string, message: string): Promise<void> {
    // TODO: integrate @aws-sdk/client-sns PublishCommand — see class doc.
    this.logger.warn(`[aws-sns stub:${this.region}] would send SMS to ${to}: ${message}`);
  }
}
