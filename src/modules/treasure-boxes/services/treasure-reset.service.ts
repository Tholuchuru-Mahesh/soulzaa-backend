import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { TreasureSessionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasureAuditService } from './treasure-audit.service';
import { TreasureBoxService } from './treasure-box.service';

@Injectable()
export class TreasureResetService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasureResetService.name);
  private _dailyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly boxService: TreasureBoxService,
    private readonly auditService: TreasureAuditService,
  ) {}

  // ---- Lifecycle ----

  onApplicationBootstrap() {
    this._scheduleDailyReset();
  }

  /**
   * Schedules a daily midnight UTC job that archives any ACTIVE sessions
   * left over from the previous day. Rooms auto-start a fresh session on the
   * next gift or room-join — no manual intervention required.
   */
  private _scheduleDailyReset(): void {
    const now = new Date();
    const nextMidnightUtc = new Date();
    nextMidnightUtc.setUTCHours(24, 0, 0, 0); // next UTC midnight
    const msUntilMidnight = nextMidnightUtc.getTime() - now.getTime();

    this.logger.log(
      `Treasure daily reset scheduled in ${Math.round(msUntilMidnight / 60000)} minutes (UTC midnight).`,
    );

    setTimeout(async () => {
      try {
        await this.archiveStaleActiveSessions();
      } catch (err) {
        this.logger.error(`Daily stale-session archive error: ${(err as Error).message}`);
      }
      // Re-schedule for the next day
      this._dailyTimer = setInterval(
        async () => {
          try {
            await this.archiveStaleActiveSessions();
          } catch (err) {
            this.logger.error(`Daily stale-session archive error: ${(err as Error).message}`);
          }
        },
        24 * 60 * 60 * 1000,
      );
    }, msUntilMidnight);
  }

  /**
   * Archives (marks as COMPLETED) any ACTIVE sessions that were created
   * on a previous UTC day. Called automatically at midnight UTC and on manual
   * fleet reset. Rooms auto-start a fresh session when the next gift arrives.
   */
  async archiveStaleActiveSessions(): Promise<{ archivedCount: number }> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const stale = await this.prisma.treasureSession.findMany({
      where: {
        status: TreasureSessionStatus.ACTIVE,
        createdAt: { lt: todayStart },
      },
    });

    for (const s of stale) {
      await this.prisma.treasureSession.update({
        where: { id: s.id },
        data: { status: TreasureSessionStatus.COMPLETED, completedAt: new Date() },
      });
      this.logger.log(
        `Archived stale ACTIVE treasure session ${s.id} for room ${s.roomId} (created ${s.createdAt.toISOString()}).`,
      );
    }

    if (stale.length > 0) {
      this.logger.log(`Daily reset: archived ${stale.length} stale session(s).`);
    }

    return { archivedCount: stale.length };
  }

  /**
   * Resets the active treasure session for a room (Archives yesterday's cycle, starts fresh).
   */
  async resetRoomTreasure(roomId: string, actorId?: string) {
    // 1. Mark existing ACTIVE sessions as RESET/ARCHIVED
    const activeSessions = await this.prisma.treasureSession.findMany({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    for (const session of activeSessions) {
      await this.prisma.treasureSession.update({
        where: { id: session.id },
        data: {
          status: TreasureSessionStatus.ARCHIVED,
          completedAt: new Date(),
        },
      });
    }

    // 2. Start a fresh new cycle
    const newSession = await this.boxService.getOrCreateActiveSession(roomId);

    // 3. Log audit event
    await this.auditService.logAudit(
      'TREASURE_RESET',
      roomId,
      undefined,
      {
        previousActiveCount: activeSessions.length,
        newSessionId: newSession?.id,
      },
      actorId,
    );

    this.logger.log(`Treasure session reset completed for room ${roomId}`);

    return {
      roomId,
      reset: true,
      newSessionId: newSession?.id ?? null,
    };
  }

  /**
   * Fleet-wide daily reset routine (scheduled or invoked automatically).
   */
  async performFleetDailyReset() {
    this.logger.log('Starting fleet-wide daily treasure box reset sweep...');

    // Find all active sessions older than 24h
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleSessions = await this.prisma.treasureSession.findMany({
      where: {
        status: TreasureSessionStatus.ACTIVE,
        createdAt: { lt: dayAgo },
      },
    });

    let resetCount = 0;
    for (const s of staleSessions) {
      await this.resetRoomTreasure(s.roomId, 'SYSTEM_DAILY_RESET');
      resetCount += 1;
    }

    this.logger.log(`Fleet-wide daily reset sweep completed. Reset ${resetCount} room session(s).`);

    return { resetCount };
  }
}
