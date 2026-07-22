import { Injectable } from '@nestjs/common';
import { Prisma, VideoRoomPkReward, VideoRoomPkRewardPool } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { Db } from './video-room-pk.repository';

/**
 * Persistence for the PK reward pool and its per-recipient reward rows
 * (VR-12). This is the phase's mint-once / pay-once boundary: two unique
 * constraints do the real work, and this repository's job is to translate a
 * P2002 unique-violation into the correct control flow instead of an
 * exception — a replayed settlement or payout is the normal path under
 * BullMQ retries, not a failure.
 *
 * No business logic lives here: no FSM validation, no domain exceptions.
 * That belongs to the services that call this repository.
 */
@Injectable()
export class VideoRoomPkRewardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Pool ----

  /**
   * Mint the pool, or report the existing one. `battleId @unique` means a
   * replayed settlement lands here with P2002; that is the SUCCESS path for a
   * retry, not a failure, so it returns `created: false` and the original row.
   * Any other error propagates so BullMQ can retry and eventually dead-letter.
   */
  async createPool(
    data: Prisma.VideoRoomPkRewardPoolUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<{ pool: VideoRoomPkRewardPool; created: boolean }> {
    try {
      return { pool: await db.videoRoomPkRewardPool.create({ data }), created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const pool = await db.videoRoomPkRewardPool.findUnique({
        where: { battleId: data.battleId },
      });
      if (!pool) throw err; // P2002 on some other constraint — do not swallow
      return { pool, created: false };
    }
  }

  getPool(battleId: string, db: Db = this.prisma): Promise<VideoRoomPkRewardPool | null> {
    return db.videoRoomPkRewardPool.findUnique({ where: { battleId } });
  }

  addAllocated(
    poolId: string,
    amount: bigint,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkRewardPool> {
    return db.videoRoomPkRewardPool.update({
      where: { id: poolId },
      data: { allocatedAmount: { increment: amount } },
    });
  }

  // ---- Rewards ----

  /**
   * Backfill the wallet transaction id onto an already-inserted reward row,
   * called right after `wallet.credit` succeeds for it. The reward↔wallet
   * link is technically recoverable via the shared `idempotencyKey` even if
   * this never runs, so a failure here is not a money-loss bug — but leaving
   * the column permanently null would be a silent trap for anyone querying
   * it directly.
   */
  setWalletTxnId(
    rewardId: string,
    walletTxnId: string,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkReward> {
    return db.videoRoomPkReward.update({
      where: { id: rewardId },
      data: { walletTxnId },
    });
  }

  /**
   * Insert a reward row, or null on a duplicate. `(battleId, userId, kind)`
   * and `idempotencyKey` are both unique, so a duplicate means this recipient
   * was already paid this kind of reward — the caller MUST skip the wallet
   * credit rather than treat this as an error. Only P2002 is swallowed; any
   * other error propagates.
   */
  async createReward(
    data: Prisma.VideoRoomPkRewardUncheckedCreateInput,
    db: Db = this.prisma,
  ): Promise<VideoRoomPkReward | null> {
    try {
      return await db.videoRoomPkReward.create({ data });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      return null;
    }
  }
}
