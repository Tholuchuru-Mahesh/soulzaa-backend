import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType, Prisma, WalletCurrency, WalletTxnReason } from '@prisma/client';
import type { DomainEvent } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { GIFT_WALLET_REFERENCE_TYPE } from 'src/modules/gifts/constants/gifts.constants';
import { GiftRefundedEvent } from 'src/modules/gifts/events/gift.events';
import type {
  GiftContextRequest,
  GiftSendContext,
  GiftSendEffects,
  IGiftContextHandler,
} from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { GiftContextRegistry } from 'src/modules/gifts/services/gift-context.registry';
import { treasureRoomLockKey } from 'src/modules/treasure-boxes/constants/treasure.constants';
import { TreasureReceiverRewardEvent } from 'src/modules/treasure-boxes/events/treasure.events';
import {
  TREASURE_BOXES_SERVICE,
  type ITreasureBoxesService,
} from 'src/modules/treasure-boxes/interfaces/treasure-boxes.service.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  AUDIO_ROOMS_SERVICE,
  type IAudioRoomsService,
} from '../interfaces/audio-rooms.service.interface';

/** Share of the accepted contribution credited to the room host. Set to 0 to prevent duplicate 10% additions to Creator Earnings. */
const HOST_REWARD_RATE = 0;

/**
 * The AUDIO_ROOM gift context (VR-10). Moved out of GiftService so the shared
 * pipeline carries no room-type dependencies — the behaviour here is the former
 * `GiftService.assertContext`, unchanged.
 *
 * Economics return 0 bps because audio-room coins do not become creator
 * earnings: they flow into the room's Treasure Box, with 10% credited to the
 * host. That routing lives in `onSend` (added alongside this class in VR-10
 * Task 4), which runs inside the send transaction.
 */
@Injectable()
export class AudioRoomGiftContextHandler implements IGiftContextHandler, OnModuleInit {
  readonly contextType = GiftContextType.AUDIO_ROOM;
  /** Audio rooms gift one recipient at a time; multi-receiver is video-only. */
  readonly maxReceivers = 1;

  constructor(
    @Inject(AUDIO_ROOMS_SERVICE) private readonly rooms: IAudioRoomsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    private readonly registry: GiftContextRegistry,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(TREASURE_BOXES_SERVICE) private readonly treasure: ITreasureBoxesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Order matters: the cheap room-state check runs before the membership
   * lookups, so a gift into a dead room costs one query rather than three.
   */
  async validate(req: GiftContextRequest): Promise<void> {
    if (req.receiverIds.length > this.maxReceivers) {
      throw new BusinessException(
        ERROR_CODES.GIFT_TOO_MANY_RECEIVERS,
        'Audio room gifts support a single recipient.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!(await this.rooms.isRoomLive(req.contextId))) {
      throw new BusinessException(
        ERROR_CODES.GIFT_CONTEXT_INVALID,
        'The room is not live.',
        HttpStatus.CONFLICT,
      );
    }
    // Throws NOT_ROOM_MEMBER when the sender is not an active member.
    await this.rooms.assertMember(req.contextId, req.senderId);

    const receiverId = req.receiverIds[0];
    // Use hasEverBeenMember instead of isMember: a member who has left the room
    // (e.g. the owner who stepped out without ending it) is still a valid gift
    // recipient while the room is LIVE. Gifts are blocked only when the room ends.
    if (!this.rooms.hasEverBeenMember) {
      console.log('DEBUG_ROOMS_MOCK', this.rooms);
    }
    const receiverInRoom = await this.rooms.hasEverBeenMember(req.contextId, receiverId);
    const receiverExists = receiverInRoom && (await this.users.findById(receiverId));
    if (!receiverExists) {
      throw new BusinessException(
        ERROR_CODES.GIFT_RECEIVER_INVALID,
        'The recipient is not a member of this room.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * The treasure session is mutated inside the send transaction, so its room
   * lock must be held for the same span as the wallet locks.
   */
  contextLockKeys(req: GiftContextRequest): string[] {
    return [treasureRoomLockKey(req.contextId)];
  }

  /**
   * Audio-room coin routing, inside the send transaction. The sender has already
   * been debited; this decides where those coins land: into the treasure box up
   * to its remaining capacity, 10% of the accepted amount to the host, and any
   * overflow straight back to the sender.
   *
   * Postgres only — the wallet credits and treasure updates all take `tx`. The
   * events returned here are published by GiftService *after* commit, so a
   * rolled-back send cannot broadcast a reward that never happened.
   */
  async onSend(tx: Prisma.TransactionClient, ctx: GiftSendContext): Promise<GiftSendEffects> {
    const receiverId = ctx.receiverIds[0];
    const events: DomainEvent<unknown>[] = [];

    const contribution = await this.treasure.processTreasureContribution(
      tx,
      ctx.contextId,
      ctx.senderId,
      receiverId,
      ctx.totalCoinValue,
      ctx.transactionId,
    );
    events.push(...contribution.events);

    const hostId = await this.rooms.getOwnerId(ctx.contextId);
    const hostReward = Math.floor(contribution.acceptedAmount * HOST_REWARD_RATE);
    if (hostId && hostReward > 0) {
      const credit = await this.wallet.credit(
        {
          userId: hostId,
          currency: WalletCurrency.GOLD,
          amount: hostReward,
          reason: WalletTxnReason.TREASURE_BOX,
          idempotencyKey: `gift-host-reward:${ctx.idempotencyKey}`,
          referenceType: GIFT_WALLET_REFERENCE_TYPE,
          referenceId: ctx.transactionId,
          actorId: ctx.senderId,
        },
        tx,
      );
      events.push(
        new TreasureReceiverRewardEvent({
          roomId: ctx.contextId,
          boxId: contribution.boxId ?? ctx.transactionId,
          level: contribution.level ?? 0,
          hostId,
          rewardAmount: hostReward,
          walletTxnId: credit.transactionId,
        }),
      );
    }

    if (contribution.refundAmount > 0) {
      await this.wallet.credit(
        {
          userId: ctx.senderId,
          currency: WalletCurrency.GOLD,
          amount: contribution.refundAmount,
          reason: WalletTxnReason.GIFT_REFUND,
          idempotencyKey: `gift-refund:${ctx.idempotencyKey}`,
          referenceType: GIFT_WALLET_REFERENCE_TYPE,
          referenceId: ctx.transactionId,
          actorId: ctx.senderId,
        },
        tx,
      );
      events.push(
        new GiftRefundedEvent({
          transactionId: ctx.transactionId,
          senderId: ctx.senderId,
          receiverId,
          roomId: ctx.contextId,
          giftId: ctx.gift.id,
          giftName: ctx.gift.name,
          totalRefundAmount: contribution.refundAmount,
          createdAt: new Date().toISOString(),
        }),
      );
    }

    // The receiver's cashback is settled once, by `GiftService` (Step 3b), at the
    // configured `gift.receiver_cashback_percentage`. A PK battle does not change
    // what a gift is worth to its recipient, so nothing extra is credited here.
    //
    // A `PK_BATTLE_RECEIVER_BONUS` credit of a further 10% used to fire at this
    // point whenever the receiver was a participant in an active battle. It
    // stacked on top of the standard cashback rather than replacing it, so the
    // same gift paid out twice: a 10,000-coin gift put 2,000 in the wallet
    // instead of 1,000. Earnings and analytics were never involved — both read
    // the gift's full value — so the discrepancy showed up only as spendable
    // balance, which is the hardest place to notice it.

    return {
      acceptedAmount: contribution.acceptedAmount,
      refundAmount: contribution.refundAmount,
      events,
      postCommit: contribution.postCommit,
    };
  }
}
