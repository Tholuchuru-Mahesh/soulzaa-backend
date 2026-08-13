import { Injectable, Logger } from '@nestjs/common';
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { treasureRoomLockKey } from '../constants/treasure.constants';
import { TreasureBoxService } from './treasure-box.service';
import { TreasureConfigurationService } from './treasure-configuration.service';

export interface ProgressResult {
  sessionId: string;
  roomId: string;
  appliedAmount: bigint;
  refundAmount: bigint;
  completedBoxes: Array<{
    boxId: string;
    level: number;
    threshold: bigint;
    finalProgress: bigint;
  }>;
  activeBox: {
    boxId: string;
    level: number;
    progress: bigint;
    threshold: bigint;
  } | null;
  sessionCompleted: boolean;
}

@Injectable()
export class TreasureProgressService {
  private readonly logger = new Logger(TreasureProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly boxService: TreasureBoxService,
    private readonly configService: TreasureConfigurationService,
  ) {}

  /**
   * Applies gift progress to a room's active treasure box with multi-box overflow support.
   * Returns a zero-contribution result if today's daily event is already COMPLETED.
   *
   * `countsTowardRanking` separates the two things a gift does to a box. Progress
   * always advances — coins are coins. But `treasure_contributions` is a pure
   * RANKING ledger (every reader of it decides who wins a box's rewards), so a
   * gift that should not buy its sender a place on the podium passes `false`:
   * the box still fills, the sender simply does not rank for it. Self-gifts use
   * this, which is why solo-filling a box in an empty room wins nothing.
   */
  async applyGiftProgress(
    roomId: string,
    userId: string,
    amount: bigint,
    giftTxnId?: string,
    contextType: string = 'AUDIO_ROOM',
    countsTowardRanking: boolean = true,
  ): Promise<ProgressResult> {
    if (amount <= BigInt(0)) {
      throw new Error('Progress amount must be greater than zero');
    }

    const lockKey = treasureRoomLockKey(roomId);
    return this.locks.withLock(lockKey, async () => {
      // Idempotency check: if this gift transaction has already been recorded in treasure contributions, skip duplicate progress.
      if (giftTxnId) {
        const existingTx = await this.prisma.treasureContribution.findFirst({
          where: { giftTxnId },
        });
        if (existingTx) {
          this.logger.log(`Treasure: skipping duplicate gift progress for giftTxnId ${giftTxnId}`);
          return {
            sessionId: existingTx.sessionId,
            roomId,
            appliedAmount: BigInt(0),
            refundAmount: BigInt(0),
            completedBoxes: [],
            activeBox: null,
            sessionCompleted: false,
          };
        }
      }

      // Guard: if today's treasure event is already COMPLETED, do not accept
      // any further gift contributions — return a no-op result immediately.
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      const completedToday = await this.prisma.treasureSession.findFirst({
        where: {
          roomId,
          status: 'COMPLETED',
          createdAt: { gte: todayStart },
        },
      });

      if (completedToday) {
        this.logger.debug(
          `Treasure: skipping gift progress for room ${roomId} — today's event already completed.`,
        );
        return {
          sessionId: completedToday.id,
          roomId,
          appliedAmount: BigInt(0),
          refundAmount: BigInt(0),
          completedBoxes: [],
          activeBox: null,
          sessionCompleted: false,
        };
      }

      const session = await this.boxService.getOrCreateActiveSession(roomId, contextType);
      if (!session) {
        return {
          sessionId: '',
          roomId,
          appliedAmount: BigInt(0),
          refundAmount: BigInt(0),
          completedBoxes: [],
          activeBox: null,
          sessionCompleted: false,
        };
      }

      let currentLevel = session.currentLevel;
      let remainingContribution = amount;
      const completedBoxes: ProgressResult['completedBoxes'] = [];
      let sessionCompleted = false;
      let refundAmount = BigInt(0);

      while (remainingContribution > BigInt(0) && currentLevel <= 5) {
        let box = await this.prisma.treasureBox.findUnique({
          where: {
            sessionId_level: { sessionId: session.id, level: currentLevel },
          },
        });

        if (!box) {
          // If box record missing, create it
          const threshold = await this.configService.getLevelThreshold(currentLevel);
          box = await this.prisma.treasureBox.create({
            data: {
              sessionId: session.id,
              roomId,
              level: currentLevel,
              threshold,
              progress: BigInt(0),
              status: TreasureBoxStatus.ACTIVE,
            },
          });
        }

        const needed = box.threshold - box.progress;

        if (remainingContribution >= needed) {
          // Fill this box completely
          const contributionForThisBox = needed;
          const newProgress = box.threshold;

          await this.prisma.treasureBox.update({
            where: { id: box.id },
            data: {
              progress: newProgress,
              status: TreasureBoxStatus.OPENED,
              openedAt: new Date(),
            },
          });

          // Record contribution ledger entry (ranking only — see the doc above)
          if (contributionForThisBox > BigInt(0) && countsTowardRanking) {
            await this.prisma.treasureContribution.create({
              data: {
                boxId: box.id,
                sessionId: session.id,
                roomId,
                userId,
                amount: contributionForThisBox,
                giftTxnId,
              },
            });
          }

          completedBoxes.push({
            boxId: box.id,
            level: currentLevel,
            threshold: box.threshold,
            finalProgress: newProgress,
          });

          remainingContribution -= needed;
          currentLevel += 1;

          // If reached after box 5, complete the entire session & refund excess coins
          if (currentLevel > 5) {
            sessionCompleted = true;
            if (remainingContribution > BigInt(0)) {
              refundAmount = remainingContribution;
              remainingContribution = BigInt(0);
            }
            await this.prisma.treasureSession.update({
              where: { id: session.id },
              data: {
                status: TreasureSessionStatus.COMPLETED,
                completedAt: new Date(),
              },
            });
            break;
          } else {
            // Unlock next box to ACTIVE status
            const nextThreshold = await this.configService.getLevelThreshold(currentLevel);
            await this.prisma.treasureBox.upsert({
              where: {
                sessionId_level: { sessionId: session.id, level: currentLevel },
              },
              update: { status: TreasureBoxStatus.ACTIVE },
              create: {
                sessionId: session.id,
                roomId,
                level: currentLevel,
                threshold: nextThreshold,
                progress: BigInt(0),
                status: TreasureBoxStatus.ACTIVE,
              },
            });

            await this.prisma.treasureSession.update({
              where: { id: session.id },
              data: { currentLevel },
            });
          }
        } else {
          // Partial fill on current box
          const newProgress = box.progress + remainingContribution;

          await this.prisma.treasureBox.update({
            where: { id: box.id },
            data: {
              progress: newProgress,
              status: TreasureBoxStatus.ACTIVE,
            },
          });

          if (countsTowardRanking) {
            await this.prisma.treasureContribution.create({
              data: {
                boxId: box.id,
                sessionId: session.id,
                roomId,
                userId,
                amount: remainingContribution,
                giftTxnId,
              },
            });
          }

          remainingContribution = BigInt(0);
        }
      }

      // Fetch active box state
      let activeBoxState: ProgressResult['activeBox'] = null;
      if (!sessionCompleted && currentLevel <= 5) {
        const activeBoxObj = await this.prisma.treasureBox.findUnique({
          where: {
            sessionId_level: { sessionId: session.id, level: currentLevel },
          },
        });
        if (activeBoxObj) {
          activeBoxState = {
            boxId: activeBoxObj.id,
            level: activeBoxObj.level,
            progress: activeBoxObj.progress,
            threshold: activeBoxObj.threshold,
          };
        }
      }

      return {
        sessionId: session.id,
        roomId,
        appliedAmount: amount - refundAmount,
        refundAmount,
        completedBoxes,
        activeBox: activeBoxState,
        sessionCompleted,
      };
    });
  }
}
