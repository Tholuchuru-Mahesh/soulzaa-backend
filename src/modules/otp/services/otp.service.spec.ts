import { ConfigService } from '@nestjs/config';
import { OtpPurpose } from '@prisma/client';
import { Queue } from 'bullmq';
import { IEventBus } from 'src/common/events';
import { OtpRepository, type OtpBlob } from '../repositories/otp.repository';
import { sha256 } from './hash.util';
import { OtpService } from './otp.service';

const CFG = {
  length: 6,
  ttlSeconds: 60,
  maxAttempts: 5,
  maxResends: 5,
  resendCooldownSeconds: 30,
  blockSeconds: 900,
};

const MOBILE = '+15551234567';
const LOGIN = OtpPurpose.LOGIN;

describe('OtpService', () => {
  let repo: jest.Mocked<
    Pick<
      OtpRepository,
      | 'identifier'
      | 'getOtp'
      | 'setOtp'
      | 'clearOtp'
      | 'incrementAttempts'
      | 'incrementResend'
      | 'clearResend'
      | 'isBlocked'
      | 'block'
      | 'createRecord'
      | 'consumeRecord'
    >
  >;
  let bus: jest.Mocked<IEventBus>;
  let smsQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let emailQueue: jest.Mocked<Pick<Queue, 'add'>>;
  let service: OtpService;

  beforeEach(() => {
    repo = {
      identifier: jest.fn((p, d) => `${p}:${d.toLowerCase()}`),
      getOtp: jest.fn().mockResolvedValue(null),
      setOtp: jest.fn().mockResolvedValue(undefined),
      clearOtp: jest.fn().mockResolvedValue(undefined),
      incrementAttempts: jest.fn(),
      incrementResend: jest.fn(),
      clearResend: jest.fn().mockResolvedValue(undefined),
      isBlocked: jest.fn().mockResolvedValue(false),
      block: jest.fn().mockResolvedValue(undefined),
      createRecord: jest.fn().mockResolvedValue({ id: 'rec1' }),
      consumeRecord: jest.fn().mockResolvedValue({ count: 1 }),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    smsQueue = { add: jest.fn().mockResolvedValue({}) };
    emailQueue = { add: jest.fn().mockResolvedValue({}) };
    const config = { get: () => CFG } as unknown as ConfigService;
    service = new OtpService(
      repo as unknown as OtpRepository,
      bus,
      smsQueue as unknown as Queue,
      emailQueue as unknown as Queue,
      config,
    );
  });

  const blob = (code: string): OtpBlob => ({
    codeHash: sha256(code),
    otpRecordId: 'rec1',
    channel: 'SMS',
    sentAt: Date.now(),
  });

  describe('generate', () => {
    it('persists, caches, enqueues SMS delivery and emits otp.generated', async () => {
      const result = await service.generate({ destination: MOBILE, purpose: LOGIN });
      expect(repo.createRecord).toHaveBeenCalled();
      expect(repo.setOtp).toHaveBeenCalled();
      expect(smsQueue.add).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'otp.generated' }));
      expect(result).toEqual({ sent: true, expiresIn: 60 });
    });

    it('routes email destinations to the email queue', async () => {
      await service.generate({ destination: 'a@b.com', purpose: LOGIN });
      expect(emailQueue.add).toHaveBeenCalled();
      expect(smsQueue.add).not.toHaveBeenCalled();
    });

    it('refuses when the destination is blocked', async () => {
      repo.isBlocked.mockResolvedValue(true);
      await expect(service.generate({ destination: MOBILE, purpose: LOGIN })).rejects.toMatchObject(
        {
          errorCode: 'OTP_BLOCKED',
        },
      );
    });

    it('enforces the resend cooldown against a live code', async () => {
      repo.getOtp.mockResolvedValue(blob('123456')); // sentAt = now
      await expect(service.generate({ destination: MOBILE, purpose: LOGIN })).rejects.toMatchObject(
        {
          errorCode: 'OTP_COOLDOWN',
        },
      );
    });
  });

  describe('resend', () => {
    it('blocks and throws once the resend limit is exceeded', async () => {
      repo.incrementResend.mockResolvedValue(CFG.maxResends + 1);
      await expect(service.resend({ destination: MOBILE, purpose: LOGIN })).rejects.toMatchObject({
        errorCode: 'OTP_RESEND_LIMIT',
      });
      expect(repo.block).toHaveBeenCalled();
    });

    it('issues a new code within the resend limit', async () => {
      repo.incrementResend.mockResolvedValue(2);
      const result = await service.resend({ destination: MOBILE, purpose: LOGIN });
      expect(result.sent).toBe(true);
      expect(smsQueue.add).toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('accepts the correct code, consumes it and emits otp.verified', async () => {
      repo.getOtp.mockResolvedValue(blob('123456'));
      repo.incrementAttempts.mockResolvedValue(1);
      await expect(
        service.verify({ destination: MOBILE, purpose: LOGIN, code: '123456' }),
      ).resolves.toBeUndefined();
      expect(repo.clearOtp).toHaveBeenCalled();
      expect(repo.consumeRecord).toHaveBeenCalledWith('rec1');
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'otp.verified' }));
    });

    it('throws OTP_EXPIRED and emits otp.expired when no live code', async () => {
      repo.getOtp.mockResolvedValue(null);
      await expect(
        service.verify({ destination: MOBILE, purpose: LOGIN, code: '000000' }),
      ).rejects.toMatchObject({ errorCode: 'OTP_EXPIRED' });
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'otp.expired' }));
    });

    it('throws OTP_INVALID on a wrong code', async () => {
      repo.getOtp.mockResolvedValue(blob('111111'));
      repo.incrementAttempts.mockResolvedValue(1);
      await expect(
        service.verify({ destination: MOBILE, purpose: LOGIN, code: '999999' }),
      ).rejects.toMatchObject({ errorCode: 'OTP_INVALID' });
    });

    it('blocks and throws OTP_MAX_ATTEMPTS past the attempt cap', async () => {
      repo.getOtp.mockResolvedValue(blob('111111'));
      repo.incrementAttempts.mockResolvedValue(CFG.maxAttempts + 1);
      await expect(
        service.verify({ destination: MOBILE, purpose: LOGIN, code: '111111' }),
      ).rejects.toMatchObject({ errorCode: 'OTP_MAX_ATTEMPTS' });
      expect(repo.block).toHaveBeenCalled();
    });

    it('refuses a blocked destination', async () => {
      repo.isBlocked.mockResolvedValue(true);
      await expect(
        service.verify({ destination: MOBILE, purpose: LOGIN, code: '111111' }),
      ).rejects.toMatchObject({ errorCode: 'OTP_BLOCKED' });
    });
  });
});
