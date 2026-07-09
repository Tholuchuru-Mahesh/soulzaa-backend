import { Injectable } from '@nestjs/common';
import { OtpChannel, OtpPurpose, OtpRecord, Prisma } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Live OTP state cached in Redis under `otp:{identifier}` (TTL-scoped). */
export interface OtpBlob {
  codeHash: string;
  otpRecordId: string;
  channel: OtpChannel;
  /** Epoch ms of the last send — drives the resend cooldown. */
  sentAt: number;
}

/**
 * Data layer for the OTP module: the four Redis keys that hold live state
 * (code, attempt counter, resend counter, abuse block) plus the durable
 * `otp_records` audit table. All Redis ops touch a single key (cluster-safe).
 * Key convention (identifier = `{purpose}:{destination}`):
 *   otp:{id}  otp_attempts:{id}  otp_resend:{id}  otp_block:{id}
 */
@Injectable()
export class OtpRepository {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  /** Stable key identifier for a (purpose, destination) pair. */
  identifier(purpose: OtpPurpose, destination: string): string {
    return `${purpose}:${destination.trim().toLowerCase()}`;
  }

  private otpKey(id: string): string {
    return `otp:${id}`;
  }
  private attemptsKey(id: string): string {
    return `otp_attempts:${id}`;
  }
  private resendKey(id: string): string {
    return `otp_resend:${id}`;
  }
  private blockKey(id: string): string {
    return `otp_block:${id}`;
  }

  // ---- Live code ----

  getOtp(id: string): Promise<OtpBlob | null> {
    return this.cache.get<OtpBlob>(this.otpKey(id));
  }

  async setOtp(id: string, blob: OtpBlob, ttlSeconds: number): Promise<void> {
    await this.cache.set(this.otpKey(id), blob, ttlSeconds);
  }

  /** Remove the live code + its attempt counter (single-use / replay guard). */
  async clearOtp(id: string): Promise<void> {
    await this.cache.del(this.otpKey(id), this.attemptsKey(id));
  }

  // ---- Attempt counter (brute-force guard) ----

  incrementAttempts(id: string, ttlSeconds: number): Promise<number> {
    return this.cache.increment(this.attemptsKey(id), { ttlSeconds });
  }

  // ---- Resend counter (duplicate-request guard) ----

  incrementResend(id: string, ttlSeconds: number): Promise<number> {
    return this.cache.increment(this.resendKey(id), { ttlSeconds });
  }

  async clearResend(id: string): Promise<void> {
    await this.cache.del(this.resendKey(id));
  }

  // ---- Abuse block ----

  isBlocked(id: string): Promise<boolean> {
    return this.cache.exists(this.blockKey(id));
  }

  async block(id: string, ttlSeconds: number): Promise<void> {
    await this.cache.set(this.blockKey(id), true, ttlSeconds);
    // Clear counters so a post-block re-request starts clean.
    await this.cache.del(this.attemptsKey(id), this.resendKey(id));
  }

  // ---- Durable audit (otp_records) ----

  createRecord(input: {
    userId?: string | null;
    purpose: OtpPurpose;
    channel: OtpChannel;
    destination: string;
    codeHash: string;
    maxAttempts: number;
    expiresAt: Date;
  }): Promise<OtpRecord> {
    return this.prisma.otpRecord.create({
      data: {
        ...input,
        destination: input.destination.toLowerCase(),
        userId: input.userId ?? null,
      },
    });
  }

  consumeRecord(id: string): Promise<Prisma.BatchPayload> {
    return this.prisma.otpRecord.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Prune audit rows created before `cutoff` (retention window). Returns count. */
  async pruneExpired(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.otpRecord.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
