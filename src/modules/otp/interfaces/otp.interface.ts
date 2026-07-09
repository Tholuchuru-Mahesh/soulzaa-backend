import type { OtpChannel, OtpPurpose } from '@prisma/client';

/**
 * Public contract for the OTP module — the ONLY surface other modules (auth,
 * and future email/mobile-change flows) may depend on. Internals (service,
 * repository, providers, processors) stay private. Consumers resolve
 * OTP_SERVICE and never touch Redis keys or otp_records directly.
 */
export const OTP_SERVICE = Symbol('OTP_SERVICE');

/** Issue/resend an OTP for a destination + purpose. */
export interface OtpGenerateCommand {
  destination: string;
  purpose: OtpPurpose;
  userId?: string | null;
}

/** Verify a submitted code. Throws a typed BusinessException on failure. */
export interface OtpVerifyCommand {
  destination: string;
  purpose: OtpPurpose;
  code: string;
}

export interface OtpIssueResult {
  sent: true;
  /** Seconds until the issued code expires (client countdown). */
  expiresIn: number;
}

export interface IOtpService {
  generate(cmd: OtpGenerateCommand): Promise<OtpIssueResult>;
  verify(cmd: OtpVerifyCommand): Promise<void>;
  resend(cmd: OtpGenerateCommand): Promise<OtpIssueResult>;
}

/** BullMQ job payload for asynchronous OTP delivery (SMS/email queues). */
export interface OtpDeliveryJob {
  channel: OtpChannel;
  destination: string;
  code: string;
  purpose: OtpPurpose;
  otpRecordId: string;
}
