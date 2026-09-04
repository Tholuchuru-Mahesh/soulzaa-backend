import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletCurrency } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { WalletService } from 'src/modules/wallet/services/wallet.service';
import { loadVideoRoomConfig, VideoRoomConfig } from '../config/video-room.config';
import { PayEntryFeeDto } from '../dto/pay-entry-fee.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomEntryAccessRepository } from '../repositories/video-room-entry-access.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

export interface VideoRoomEntryStatusView {
  requiresPayment: boolean;
  isLive: boolean;
  roomId: string;
  sessionId: string | null;
  paidEntryEnabled: boolean;
  entryFee: number;
  alreadyAuthorized: boolean;
  isOwnerOrMod?: boolean;
}

export interface VideoRoomEntryPaymentResult {
  success: boolean;
  accessId?: string;
  amountPaid: number;
  creatorEarnings: number;
  sessionId: string;
  alreadyAuthorized?: boolean;
}

@Injectable()
export class VideoRoomEntryPaymentService {
  private readonly logger = new Logger(VideoRoomEntryPaymentService.name);
  private readonly config: VideoRoomConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: VideoRoomsRepository,
    private readonly entryAccessRepo: VideoRoomEntryAccessRepository,
    private readonly walletService: WalletService,
    private readonly locks: LockService,
    config: ConfigService,
  ) {
    this.config = loadVideoRoomConfig(config);
  }

  /**
   * Check whether a user needs to pay entry fee to enter the active broadcast session of a room.
   */
  async checkEntryStatus(
    userId: string,
    roomId: string,
    actorRoles?: string[],
  ): Promise<VideoRoomEntryStatusView> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const activeSession = await this.repo.getActiveBroadcastSession(roomId);
    const isLive = activeSession !== null && activeSession.status === 'LIVE';

    const isHost = room.ownerId === userId;
    const isModOrAdmin = (actorRoles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (isHost || isModOrAdmin) {
      return {
        requiresPayment: false,
        isLive,
        roomId,
        sessionId: activeSession?.id ?? null,
        paidEntryEnabled: activeSession?.paidEntryEnabled ?? room.paidEntryEnabled ?? false,
        entryFee: Number(activeSession?.entryFee ?? room.defaultEntryFee ?? 0),
        alreadyAuthorized: true,
        isOwnerOrMod: true,
      };
    }

    // If there is an active session, use the session's snapshotted paid entry configuration
    if (activeSession && activeSession.status === 'LIVE') {
      const sessionPaidEntryEnabled = activeSession.paidEntryEnabled ?? false;
      const sessionEntryFee = Number(activeSession.entryFee ?? 0);

      if (!sessionPaidEntryEnabled || sessionEntryFee <= 0) {
        return {
          requiresPayment: false,
          isLive: true,
          roomId,
          sessionId: activeSession.id,
          paidEntryEnabled: false,
          entryFee: 0,
          alreadyAuthorized: true,
        };
      }

      // Check if user has already paid for THIS session
      const hasAccess = await this.entryAccessRepo.hasGrantedAccess(
        userId,
        activeSession.id,
      );

      return {
        requiresPayment: !hasAccess,
        isLive: true,
        roomId,
        sessionId: activeSession.id,
        paidEntryEnabled: true,
        entryFee: sessionEntryFee,
        alreadyAuthorized: hasAccess,
      };
    }

    // If room is OFFLINE, report the room default configuration
    const roomPaidEntryEnabled = room.paidEntryEnabled ?? false;
    const roomEntryFee = Number(room.defaultEntryFee ?? 0);

    return {
      requiresPayment: roomPaidEntryEnabled && roomEntryFee > 0,
      isLive: false,
      roomId,
      sessionId: null,
      paidEntryEnabled: roomPaidEntryEnabled,
      entryFee: roomEntryFee,
      alreadyAuthorized: false,
    };
  }

  /**
   * Process entry fee payment and grant access entitlement to the current broadcast session.
   */
  async payAndGrantAccess(
    actor: RoomActor,
    roomId: string,
    sessionId: string,
    dto: PayEntryFeeDto,
  ): Promise<VideoRoomEntryPaymentResult> {
    const lockKey = `video_room_entry_payment:${sessionId}:${actor.id}`;

    return this.locks.withLock(lockKey, async () => {
      const room = await this.repo.findById(roomId);
      if (!room) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
          `Video room ${roomId} was not found.`,
          HttpStatus.NOT_FOUND,
        );
      }

      const session = await this.repo.findBroadcastSessionById(sessionId);
      if (!session || session.roomId !== roomId) {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
          'Broadcast session not found for this room.',
          HttpStatus.NOT_FOUND,
        );
      }

      if (session.status !== 'LIVE') {
        throw new BusinessException(
          ERROR_CODES.VIDEO_ROOM_ENDED,
          'This broadcast session has already ended.',
          HttpStatus.GONE,
        );
      }

      // Room owner / host does not pay
      if (room.ownerId === actor.id || session.hostId === actor.id) {
        return {
          success: true,
          amountPaid: 0,
          creatorEarnings: 0,
          sessionId,
          alreadyAuthorized: true,
        };
      }

      // If session is not paid entry, grant access immediately
      if (!session.paidEntryEnabled || !session.entryFee || session.entryFee <= 0n) {
        return {
          success: true,
          amountPaid: 0,
          creatorEarnings: 0,
          sessionId,
          alreadyAuthorized: true,
        };
      }

      // Check if user already holds granted access for this session
      const existingAccess = await this.entryAccessRepo.findAccess(actor.id, sessionId);
      if (existingAccess && existingAccess.status === 'GRANTED') {
        return {
          success: true,
          accessId: existingAccess.id,
          amountPaid: Number(existingAccess.amountPaid),
          creatorEarnings: Number(existingAccess.creatorEarnings),
          sessionId,
          alreadyAuthorized: true,
        };
      }

      const entryFee = BigInt(session.entryFee);
      const creatorPercentage = BigInt(this.config.entryCreatorPercentage ?? 100);
      const creatorEarnings = (entryFee * creatorPercentage) / 100n;
      const hostId = session.hostId || room.ownerId;

      // Verify wallet balance before running transaction
      const balances = await this.walletService.getBalance(actor.id);
      if (BigInt(balances.gold) < entryFee) {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          `Insufficient Gold Coins. This room requires ${entryFee} Gold Coins to enter.`,
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      // Execute atomic transaction for wallet deduction, creator credit, access record, and session stats
      return this.prisma.$transaction(async (tx) => {
        // Re-verify session is still LIVE inside transaction
        const liveCheck = await (tx as any).videoBroadcastSession.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        if (!liveCheck || liveCheck.status !== 'LIVE') {
          throw new BusinessException(
            ERROR_CODES.VIDEO_ROOM_ENDED,
            'This broadcast session has ended.',
            HttpStatus.GONE,
          );
        }

        // 1. Debit entrant Gold Coins
        const debitResult = await this.walletService.debit(
          {
            userId: actor.id,
            currency: WalletCurrency.GOLD,
            amount: Number(entryFee),
            reason: 'VIDEO_ROOM_ENTRY_FEE' as any,
            referenceType: 'VIDEO_ROOM_BROADCAST_SESSION',
            referenceId: sessionId,
            idempotencyKey: dto.idempotencyKey,
            metadata: {
              roomId,
              sessionId,
              entryFee: Number(entryFee),
              hostId,
            },
            actorId: actor.id,
          },
          tx,
        );

        // 2. Credit creator Diamonds/Earnings
        if (creatorEarnings > 0n) {
          await this.walletService.credit(
            {
              userId: hostId,
              currency: WalletCurrency.DIAMOND,
              amount: Number(creatorEarnings),
              reason: 'VIDEO_ROOM_ENTRY_EARNING' as any,
              referenceType: 'VIDEO_ROOM_BROADCAST_SESSION',
              referenceId: sessionId,
              idempotencyKey: `earning:${dto.idempotencyKey}:${hostId}`,
              metadata: {
                roomId,
                sessionId,
                entrantUserId: actor.id,
                amountPaid: Number(entryFee),
                creatorPercentage: Number(creatorPercentage),
              },
              actorId: actor.id,
            },
            tx,
          );
        }

        // 3. Create or update VideoRoomEntryAccess record
        const access = await this.entryAccessRepo.grantAccess(
          {
            userId: actor.id,
            roomId,
            sessionId,
            amountPaid: entryFee,
            creatorEarnings,
            transactionId: debitResult.transactionId,
          },
          tx,
        );

        // 4. Update VideoBroadcastSession metrics
        await (tx as any).videoBroadcastSession.update({
          where: { id: sessionId },
          data: {
            totalPaidEntrants: { increment: 1 },
            totalEntryRevenue: { increment: entryFee },
            entryCreatorEarnings: { increment: creatorEarnings },
          },
        });

        this.logger.log(
          `Granted Paid Entry access to user ${actor.id} for video room ${roomId}, session ${sessionId} (Fee: ${entryFee} Gold)`,
        );

        return {
          success: true,
          accessId: access.id,
          amountPaid: Number(entryFee),
          creatorEarnings: Number(creatorEarnings),
          sessionId,
        };
      });
    });
  }
}
