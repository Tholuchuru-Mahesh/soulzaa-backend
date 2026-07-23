import { Injectable, Logger } from '@nestjs/common';
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasureAuditService } from './treasure-audit.service';
import { TreasureBoxService } from './treasure-box.service';

@Injectable()
export class TreasureResetService {
  private readonly logger = new Logger(TreasureResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly boxService: TreasureBoxService,
    private readonly auditService: TreasureAuditService,
  ) {}

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
        newSessionId: newSession.id,
      },
      actorId,
    );

    this.logger.log(`Treasure session reset completed for room ${roomId}`);

    return {
      roomId,
      reset: true,
      newSessionId: newSession.id,
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
