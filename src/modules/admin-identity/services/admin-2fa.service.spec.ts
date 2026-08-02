import { UnauthorizedException } from '@nestjs/common';
import { OTP } from 'otplib';
import { Admin2faService } from './admin-2fa.service';

/**
 * Spec §2 / §23: TOTP second factor on the staff portal.
 *
 * The rules these tests pin down, in order of how badly getting them wrong
 * would hurt: an unenrolled account must not pass the factor by default, an
 * enrolment that was never confirmed must not count, and a wrong code must
 * fail closed.
 */
describe('Admin2faService', () => {
  const otp = new OTP({ strategy: 'totp' });
  const repo = {
    getCredential: jest.fn(),
    saveSecret: jest.fn(),
    markEnrolled: jest.fn(),
  } as any;

  let service: Admin2faService;
  let secret: string;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new Admin2faService(repo);
    secret = otp.generateSecret();
  });

  const validCodeFor = (s: string) => otp.generate({ secret: s });

  describe('verify', () => {
    it('accepts a valid code for an enrolled account', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: new Date() });
      await expect(service.verify('admin-1', await validCodeFor(secret))).resolves.toBe(true);
    });

    it('rejects an incorrect code', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: new Date() });
      await expect(service.verify('admin-1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when the account has never enrolled', async () => {
      repo.getCredential.mockResolvedValue(null);
      await expect(service.verify('admin-1', '123456')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when enrolment was started but never confirmed', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: null });
      await expect(service.verify('admin-1', await validCodeFor(secret))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an empty code rather than treating it as absent', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: new Date() });
      await expect(service.verify('admin-1', '')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('beginEnrolment', () => {
    it('stores a fresh secret and returns it with an otpauth URI', async () => {
      repo.getCredential.mockResolvedValue(null);
      const result = await service.beginEnrolment('admin-1', 'ops1');

      expect(repo.saveSecret).toHaveBeenCalledWith('admin-1', result.secret);
      expect(result.otpauthUri).toContain('otpauth://totp/');
      expect(result.otpauthUri).toContain(result.secret);
    });

    it('refuses to re-enrol an already-confirmed account', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: new Date() });
      await expect(service.beginEnrolment('admin-1', 'ops1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('confirmEnrolment', () => {
    it('marks the account enrolled when the first code is correct', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: null });
      await service.confirmEnrolment('admin-1', await validCodeFor(secret));
      expect(repo.markEnrolled).toHaveBeenCalledWith('admin-1');
    });

    it('does not enrol when the code is wrong', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: null });
      await expect(service.confirmEnrolment('admin-1', '000000')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repo.markEnrolled).not.toHaveBeenCalled();
    });
  });

  describe('isEnrolled', () => {
    it('is true only once enrolment is confirmed', async () => {
      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: new Date() });
      await expect(service.isEnrolled('admin-1')).resolves.toBe(true);

      repo.getCredential.mockResolvedValue({ totpSecret: secret, enrolledAt: null });
      await expect(service.isEnrolled('admin-1')).resolves.toBe(false);

      repo.getCredential.mockResolvedValue(null);
      await expect(service.isEnrolled('admin-1')).resolves.toBe(false);
    });
  });
});
