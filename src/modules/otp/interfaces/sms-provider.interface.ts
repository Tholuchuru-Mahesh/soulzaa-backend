export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/** Identifiers for the supported SMS transports (selected by OTP_SMS_PROVIDER). */
export type SmsProviderName = 'console' | 'twilio' | 'msg91' | 'aws_sns';

/**
 * Sends a text message to a phone number. Implementations wrap a concrete
 * transport (Twilio, MSG91, AWS SNS) or log (console). OtpService/processors
 * depend only on this interface, so a provider is added without touching the
 * OTP flow — swap the SMS_PROVIDER binding.
 */
export interface ISmsProvider {
  readonly name: SmsProviderName;
  send(to: string, message: string): Promise<void>;
}
