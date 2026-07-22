import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { WalletCurrency, WalletTxnReason, type GiftTransaction } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { GIFT_WALLET_REFERENCE_TYPE } from 'src/modules/gifts/constants/gifts.constants';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VIDEO_ROOM_GIFT_EVENT_TYPES } from '../constants/video-room-gift.constants';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomGiftRepository } from '../repositories/video-room-gift.repository';

/** Outcome of a reversal, per leg. */
export interface GiftReversalResult {
  transactionId: string;
  receiverId: string;
  refundedToSender: number;
  clawedBackFromReceiver: number;
}

/**
 * Admin-only corrections to committed gifts (VR-10 transaction types).
 *
 * A gift is normally terminal — the ledger is append-only and the coins have
 * moved. These operations exist for the cases where that must be undone:
 * chargebacks, fraud, and operator error.
 *
 * Reversal is the inverse of a send, performed with the same discipline: sorted
 * locks, one ACID transaction, and idempotency keys derived from the original
 * transaction id so replaying a reversal cannot double-refund. It is NOT a
 * second gift in the opposite direction — the original row is marked REVERSED
 * rather than deleted, so history stays truthful.
 */
@Injectable()
export class VideoRoomGiftReversalService {
  private readonly logger = new Logger(VideoRoomGiftReversalService.name);

  constructor(
    private readonly repo: VideoRoomGiftRepository,
    private readonly events: VideoRoomEventsRepository,
    /**
     * Injected ONLY to open the ACID boundary via `$transaction` — never for
     * model access, which all goes through `repo`. This mirrors how the shared
     * GiftService owns the send transaction while its repository owns the rows.
     */
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  /**
   * Reverse a single gift leg: refund the sender what they paid, claw back the
   * earnings the receiver was credited, and mark the row REVERSED.
   */
  async reverseTransaction(
    roomId: string,
    transactionId: string,
    adminId: string,
    reason: string,
  ): Promise<GiftReversalResult> {
    const txn = await this.repo.findRoomTransaction(roomId, transactionId);
    if (!txn) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TRANSACTION_NOT_FOUND,
        'Gift transaction not found in this room.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.reverseOne(roomId, txn, adminId, reason);
  }

  /**
   * Reverse every leg of a batch. A "gift the stage" send was one user action
   * and one charge, so partially reversing it would leave the sender out of
   * pocket for an action they did not take.
   */
  async reverseBatch(
    roomId: string,
    batchId: string,
    adminId: string,
    reason: string,
  ): Promise<GiftReversalResult[]> {
    const legs = await this.repo.findBatch(roomId, batchId);
    if (legs.length === 0) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TRANSACTION_NOT_FOUND,
        'No gift transactions found for that batch.',
        HttpStatus.NOT_FOUND,
      );
    }

    const results: GiftReversalResult[] = [];
    for (const leg of legs) {
      // Sequential, not parallel: each leg takes wallet locks, and reversing a
      // batch concurrently would contend on the sender's wallet with itself.
      results.push(await this.reverseOne(roomId, leg, adminId, reason));
    }
    return results;
  }

  private async reverseOne(
    roomId: string,
    txn: GiftTransaction,
    adminId: string,
    reason: string,
  ): Promise<GiftReversalResult> {
    if (txn.status !== 'COMPLETED') {
      throw new BusinessException(
        ERROR_CODES.GIFT_ALREADY_REVERSED,
        'This gift has already been reversed.',
        HttpStatus.CONFLICT,
      );
    }

    const refund = Number(txn.totalCoinValue);
    const clawback = Number(txn.creatorEarnings);
    // Same sorted-lock discipline as the send, so a reversal and a concurrent
    // send involving these two wallets can never deadlock each other.
    const lockKeys = [txn.senderId, txn.receiverId].map(walletLockKey).sort();

    const result = await this.withLocks(lockKeys, () =>
      this.prisma.$transaction(async (tx) => {
        // Conditional update first: if another admin already reversed this, we
        // stop before moving any coins.
        const claimed = await this.repo.markReversed(txn.id, reason, adminId, txn.metadata, tx);
        if (!claimed) {
          throw new BusinessException(
            ERROR_CODES.GIFT_ALREADY_REVERSED,
            'This gift has already been reversed.',
            HttpStatus.CONFLICT,
          );
        }

        // Claw back the receiver's earnings before refunding the sender: if the
        // receiver has already spent them the debit fails, the transaction rolls
        // back, and we have not handed the sender coins the platform never
        // recovered.
        if (clawback > 0) {
          await this.wallet.debit(
            {
              userId: txn.receiverId,
              currency: WalletCurrency.EARNINGS,
              amount: clawback,
              reason: WalletTxnReason.GIFT_REFUND,
              idempotencyKey: `gift-reversal-clawback:${txn.id}`,
              referenceType: GIFT_WALLET_REFERENCE_TYPE,
              referenceId: txn.id,
              actorId: adminId,
            },
            tx,
          );
        }

        if (refund > 0) {
          await this.wallet.credit(
            {
              userId: txn.senderId,
              currency: WalletCurrency.GOLD,
              amount: refund,
              reason: WalletTxnReason.GIFT_REFUND,
              idempotencyKey: `gift-reversal-refund:${txn.id}`,
              referenceType: GIFT_WALLET_REFERENCE_TYPE,
              referenceId: txn.id,
              actorId: adminId,
            },
            tx,
          );
        }

        return {
          transactionId: txn.id,
          receiverId: txn.receiverId,
          refundedToSender: refund,
          clawedBackFromReceiver: clawback,
        };
      }),
    );

    await this.audit(roomId, txn, adminId, reason);
    return result;
  }

  /** Append the reversal to the room's event stream. Never fails the reversal. */
  private async audit(
    roomId: string,
    txn: GiftTransaction,
    adminId: string,
    reason: string,
  ): Promise<void> {
    const batchId = (txn.metadata as { batchId?: string } | null)?.batchId ?? txn.id;
    try {
      await this.events.appendEvent({
        roomId,
        actorId: adminId,
        eventType: VIDEO_ROOM_GIFT_EVENT_TYPES.REVERSED,
        payload: {
          transactionId: txn.id,
          batchId,
          senderId: txn.senderId,
          receiverId: txn.receiverId,
          giftId: txn.giftId,
          refundedToSender: Number(txn.totalCoinValue),
          clawedBackFromReceiver: Number(txn.creatorEarnings),
          adminId,
          reason,
        },
        referenceId: txn.id,
        correlationId: batchId,
      });
    } catch (err) {
      this.logger.error(`failed to audit reversal of gift ${txn.id}: ${(err as Error).message}`);
    }
  }

  private withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return keys.reduceRight<() => Promise<T>>(
      (next, key) => () => this.locks.withLock(key, next),
      fn,
    )();
  }
}
