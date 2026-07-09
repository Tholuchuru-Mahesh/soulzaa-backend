import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  OtpFailedEvent,
  OtpGeneratedEvent,
  OtpVerifiedEvent,
  OtpExpiredEvent,
} from '../events/otp.events';
import {
  type IOtpService,
  type OtpDeliveryJob,
  type OtpGenerateCommand,
  type OtpIssueResult,
  type OtpVerifyCommand,
} from '../interfaces/otp.interface';
import { OTP_JOBS, OTP_QUEUES } from '../otp.constants';
import { OtpRepository } from '../repositories/otp.repository';
import { randomNumericCode, safeEqualHex, sha256 } from './hash.util';

/**
 * OTP lifecycle orchestrator (generate / verify / resend) with brute-force,
 * replay, duplicate-request and abuse protections. Live state is in Redis (via
 * OtpRepository); delivery is async through the OTP BullMQ queues; every
 * transition publishes an event. Command/query paths are kept separate.
 */
@Injectable()
export class OtpService implements IOtpService {
  private readonly length: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly maxResends: number;
  private readonly resendCooldownMs: number;
  private readonly blockSeconds: number;

  constructor(
    private readonly repo: OtpRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @InjectQueue(OTP_QUEUES.SMS) private readonly smsQueue: Queue,
    @InjectQueue(OTP_QUEUES.EMAIL) private readonly emailQueue: Queue,
    config: ConfigService,
  ) {
    const otp = config.get('otp', { infer: true })!;
    this.length = Number(otp.length);
    this.ttlSeconds = Number(otp.ttlSeconds);
    this.maxAttempts = Number(otp.maxAttempts);
    this.maxResends = Number(otp.maxResends);
    this.resendCooldownMs = Number(otp.resendCooldownSeconds) * 1000;
    this.blockSeconds = Number(otp.blockSeconds);
  }

  // ---- Commands ----

  async generate(cmd: OtpGenerateCommand): Promise<OtpIssueResult> {
    const id = this.repo.identifier(cmd.purpose, cmd.destination);
    await this.assertNotBlocked(id, cmd);
    await this.assertCooldownElapsed(id);
    // Fresh OTP session — reset the resend counter.
    await this.repo.clearResend(id);
    return this.issue(id, cmd);
  }

  async resend(cmd: OtpGenerateCommand): Promise<OtpIssueResult> {
    const id = this.repo.identifier(cmd.purpose, cmd.destination);
    await this.assertNotBlocked(id, cmd);
    await this.assertCooldownElapsed(id);

    const count = await this.repo.incrementResend(id, this.blockSeconds);
    if (count > this.maxResends) {
      await this.repo.block(id, this.blockSeconds);
      await this.publishFailure(cmd, 'blocked');
      throw new BusinessException(
        ERROR_CODES.OTP_RESEND_LIMIT,
        'Too many OTP requests. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.issue(id, cmd);
  }

  async verify(cmd: OtpVerifyCommand): Promise<void> {
    const id = this.repo.identifier(cmd.purpose, cmd.destination);
    const channel = this.channelFor(cmd.destination);

    if (await this.repo.isBlocked(id)) {
      await this.publishFailure(cmd, 'blocked');
      throw new BusinessException(
        ERROR_CODES.OTP_BLOCKED,
        'Too many attempts. This destination is temporarily blocked.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const blob = await this.repo.getOtp(id);
    if (!blob) {
      await this.bus.publish(
        new OtpExpiredEvent({
          destination: cmd.destination,
          purpose: cmd.purpose,
          channel,
        }),
      );
      throw new BusinessException(
        ERROR_CODES.OTP_EXPIRED,
        'OTP has expired',
        HttpStatus.BAD_REQUEST,
      );
    }

    const attempts = await this.repo.incrementAttempts(id, this.ttlSeconds);
    if (attempts > this.maxAttempts) {
      await this.repo.block(id, this.blockSeconds);
      await this.publishFailure(cmd, 'max_attempts');
      throw new BusinessException(
        ERROR_CODES.OTP_MAX_ATTEMPTS,
        'Too many incorrect attempts. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!safeEqualHex(sha256(cmd.code), blob.codeHash)) {
      await this.publishFailure(cmd, 'invalid');
      throw new BusinessException(
        ERROR_CODES.OTP_INVALID,
        'OTP is incorrect',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Success — single-use: clear code + counters, mark the audit row consumed.
    await this.repo.clearOtp(id);
    await this.repo.clearResend(id);
    await this.repo.consumeRecord(blob.otpRecordId);
    await this.bus.publish(
      new OtpVerifiedEvent({
        destination: cmd.destination,
        purpose: cmd.purpose,
        channel: blob.channel,
        userId: null,
        otpRecordId: blob.otpRecordId,
      }),
    );
  }

  // ---- Internal ----

  /** Generate, persist, cache and enqueue a code. Emits otp.generated. */
  private async issue(id: string, cmd: OtpGenerateCommand): Promise<OtpIssueResult> {
    const channel = this.channelFor(cmd.destination);
    const code = randomNumericCode(this.length);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

    const record = await this.repo.createRecord({
      userId: cmd.userId ?? null,
      purpose: cmd.purpose,
      channel,
      destination: cmd.destination,
      codeHash: sha256(code),
      maxAttempts: this.maxAttempts,
      expiresAt,
    });

    await this.repo.setOtp(
      id,
      { codeHash: sha256(code), otpRecordId: record.id, channel, sentAt: Date.now() },
      this.ttlSeconds,
    );

    await this.enqueueDelivery({
      channel,
      destination: cmd.destination,
      code,
      purpose: cmd.purpose,
      otpRecordId: record.id,
    });

    await this.bus.publish(
      new OtpGeneratedEvent({
        destination: cmd.destination,
        purpose: cmd.purpose,
        channel,
        userId: cmd.userId ?? null,
        otpRecordId: record.id,
      }),
    );

    return { sent: true, expiresIn: this.ttlSeconds };
  }

  private enqueueDelivery(job: OtpDeliveryJob): Promise<unknown> {
    const queue = job.channel === OtpChannel.EMAIL ? this.emailQueue : this.smsQueue;
    return queue.add(OTP_JOBS.DELIVER, job);
  }

  private async assertNotBlocked(id: string, cmd: OtpGenerateCommand): Promise<void> {
    if (await this.repo.isBlocked(id)) {
      await this.publishFailure(cmd, 'blocked');
      throw new BusinessException(
        ERROR_CODES.OTP_BLOCKED,
        'Too many requests. This destination is temporarily blocked.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Reject a new send while a live code is still within the resend cooldown. */
  private async assertCooldownElapsed(id: string): Promise<void> {
    const blob = await this.repo.getOtp(id);
    if (blob && Date.now() - blob.sentAt < this.resendCooldownMs) {
      const retryIn = Math.ceil((this.resendCooldownMs - (Date.now() - blob.sentAt)) / 1000);
      throw new BusinessException(
        ERROR_CODES.OTP_COOLDOWN,
        `Please wait ${retryIn}s before requesting another code`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private publishFailure(
    cmd: OtpGenerateCommand | OtpVerifyCommand,
    reason: 'invalid' | 'max_attempts' | 'blocked',
  ): Promise<void> {
    return this.bus.publish(
      new OtpFailedEvent({
        destination: cmd.destination,
        purpose: cmd.purpose,
        channel: this.channelFor(cmd.destination),
        userId: 'userId' in cmd ? (cmd.userId ?? null) : null,
        reason,
      }),
    );
  }

  /** SMS for phone numbers, email for addresses. */
  private channelFor(destination: string): OtpChannel {
    return destination.includes('@') ? OtpChannel.EMAIL : OtpChannel.SMS;
  }
}
