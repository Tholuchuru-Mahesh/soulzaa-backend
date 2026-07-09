import type { OtpChannel, OtpPurpose } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * OTP lifecycle events published on the EVENT_BUS. Other modules (analytics,
 * notification, security monitoring) can subscribe. Payloads never carry the
 * plaintext code. Names are dot-namespaced for transport-swap compatibility.
 */

export const OTP_EVENTS = {
  GENERATED: 'otp.generated',
  SENT: 'otp.sent',
  VERIFIED: 'otp.verified',
  EXPIRED: 'otp.expired',
  FAILED: 'otp.failed',
} as const;

/** Why an OTP verification failed (for otp.failed). */
export type OtpFailureReason = 'invalid' | 'max_attempts' | 'blocked' | 'expired';

interface OtpBase {
  destination: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
  userId?: string | null;
}

export class OtpGeneratedEvent extends DomainEvent<OtpBase & { otpRecordId: string }> {
  readonly name = OTP_EVENTS.GENERATED;
}

export class OtpSentEvent extends DomainEvent<OtpBase & { otpRecordId: string; provider: string }> {
  readonly name = OTP_EVENTS.SENT;
}

export class OtpVerifiedEvent extends DomainEvent<OtpBase & { otpRecordId: string }> {
  readonly name = OTP_EVENTS.VERIFIED;
}

export class OtpExpiredEvent extends DomainEvent<
  Omit<OtpBase, 'channel'> & { channel?: OtpChannel }
> {
  readonly name = OTP_EVENTS.EXPIRED;
}

export class OtpFailedEvent extends DomainEvent<
  Omit<OtpBase, 'channel'> & { channel?: OtpChannel; reason: OtpFailureReason }
> {
  readonly name = OTP_EVENTS.FAILED;
}
