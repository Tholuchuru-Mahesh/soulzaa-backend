import { ConfigService } from '@nestjs/config';
import type { ISmsProvider, SmsProviderName } from '../../interfaces/sms-provider.interface';
import { AwsSnsSmsProvider } from './aws-sns-sms.provider';
import { ConsoleSmsProvider } from './console-sms.provider';
import { Msg91SmsProvider } from './msg91-sms.provider';
import { SmsProviderRegistry } from './sms-provider.registry';
import { TwilioSmsProvider } from './twilio-sms.provider';

/** A minimal fake standing in for each concrete provider. */
const fake = (name: SmsProviderName): ISmsProvider => ({ name, send: jest.fn() });

function registryFor(selected: SmsProviderName): SmsProviderRegistry {
  const config = { get: () => ({ smsProvider: selected }) } as unknown as ConfigService;
  return new SmsProviderRegistry(
    config,
    fake('console') as ConsoleSmsProvider,
    fake('twilio') as TwilioSmsProvider,
    fake('msg91') as Msg91SmsProvider,
    fake('aws_sns') as AwsSnsSmsProvider,
  );
}

describe('SmsProviderRegistry', () => {
  it.each<SmsProviderName>(['console', 'twilio', 'msg91', 'aws_sns'])(
    'resolves the configured provider "%s"',
    (name) => {
      expect(registryFor(name).resolve().name).toBe(name);
    },
  );
});
