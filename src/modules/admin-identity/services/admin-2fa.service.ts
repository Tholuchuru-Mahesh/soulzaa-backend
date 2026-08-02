import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { OTP } from 'otplib';
import { AdminCredentialRepository } from '../repositories/admin-credential.repository';

/** Shown to the operator once, at enrolment, so an authenticator app can scan it. */
export interface EnrolmentChallenge {
  secret: string;
  otpauthUri: string;
}

/**
 * TOTP second factor for hidden staff accounts (spec §2, §23).
 *
 * Enrolment is two-phase on purpose: `beginEnrolment` stores a secret but leaves
 * `enrolledAt` null, and only `confirmEnrolment` — which requires a working code
 * — marks it active. Without that split, an operator who scanned the QR badly
 * would be locked out of their own account with a second factor they cannot
 * satisfy.
 *
 * Every failure path throws UnauthorizedException rather than returning false,
 * so a caller cannot accidentally treat a falsy result as "no second factor
 * required" and wave the login through.
 */
@Injectable()
export class Admin2faService {
  private readonly logger = new Logger(Admin2faService.name);
  private readonly otp = new OTP({ strategy: 'totp' });

  constructor(private readonly repo: AdminCredentialRepository) {}

  async verify(userId: string, code: string): Promise<true> {
    const credential = await this.repo.getCredential(userId);
    // Same error for "never enrolled", "not confirmed" and "wrong code": the
    // response must not tell an attacker which staff accounts have 2FA set up.
    if (!credential?.enrolledAt || !code) {
      throw new UnauthorizedException('Two-factor authentication failed');
    }

    const result = await this.otp.verify({ secret: credential.totpSecret, token: code });
    if (!result.valid) {
      this.logger.warn(`2FA failure for ${userId}`);
      throw new UnauthorizedException('Two-factor authentication failed');
    }
    return true;
  }

  async beginEnrolment(userId: string, label: string): Promise<EnrolmentChallenge> {
    const existing = await this.repo.getCredential(userId);
    if (existing?.enrolledAt) {
      // Re-enrolling would silently invalidate the operator's current
      // authenticator; that has to be a deliberate reset, not a side effect.
      throw new UnauthorizedException('Account already enrolled — reset 2FA first');
    }

    const secret = this.otp.generateSecret();
    await this.repo.saveSecret(userId, secret);

    const issuer = encodeURIComponent('Soulzaa');
    const account = encodeURIComponent(label);
    return {
      secret,
      otpauthUri: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}`,
    };
  }

  async confirmEnrolment(userId: string, code: string): Promise<true> {
    const credential = await this.repo.getCredential(userId);
    if (!credential || !code) {
      throw new UnauthorizedException('No enrolment in progress');
    }

    const result = await this.otp.verify({ secret: credential.totpSecret, token: code });
    if (!result.valid) {
      throw new UnauthorizedException('Code did not match — enrolment not completed');
    }

    await this.repo.markEnrolled(userId);
    return true;
  }

  async isEnrolled(userId: string): Promise<boolean> {
    const credential = await this.repo.getCredential(userId);
    return credential?.enrolledAt != null;
  }
}
