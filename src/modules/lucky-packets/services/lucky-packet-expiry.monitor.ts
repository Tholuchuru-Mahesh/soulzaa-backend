import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LockService } from 'src/infra/redis/lock.service';
import {
  LUCKY_PACKET_MONITOR_INTERVAL_MS,
  LUCKY_PACKET_MONITOR_LOCK_KEY,
} from '../constants/lucky-packet.constants';
import { LuckyPacketService } from './lucky-packet.service';

/**
 * Refunds/expires lucky packets whose claim window has elapsed: finds ACTIVE
 * packets past `expiresAt`, credits the unclaimed remainder back to the creator
 * (idempotently), marks them REFUNDED/EXPIRED, and broadcasts expiry. Guarded by
 * a short Redis lock so exactly one instance runs per tick across the fleet
 * (mirrors AR-6's RocketExpiryMonitor).
 */
@Injectable()
export class LuckyPacketExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LuckyPacketExpiryMonitor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly packets: LuckyPacketService,
    private readonly locks: LockService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), LUCKY_PACKET_MONITOR_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const release = await this.locks.acquire(
        LUCKY_PACKET_MONITOR_LOCK_KEY,
        LUCKY_PACKET_MONITOR_INTERVAL_MS,
      );
      if (!release) return;
      try {
        await this.packets.refundExpired(new Date());
      } finally {
        await release();
      }
    } catch (err) {
      this.logger.warn(`Lucky packet expiry sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
