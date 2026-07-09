export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export type EmailProviderName = 'console' | 'smtp';

/**
 * Sends a transactional email. Kept behind an interface so the transport
 * (SES/SMTP) can be swapped without touching the OTP flow.
 */
export interface IEmailProvider {
  readonly name: EmailProviderName;
  send(to: string, subject: string, body: string): Promise<void>;
}
