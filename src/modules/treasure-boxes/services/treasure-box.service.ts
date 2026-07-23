import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasureConfigurationService } from './treasure-configuration.service';

export interface BoxStatusView {
  id: string;
  sessionId: string;
  roomId: string;
  level: number;
  threshold: string;
  progress: string;
  status: TreasureBoxStatus | string;
  openedAt?: Date | null;
}

@Injectable()
export class TreasureBoxService {
  private readonly logger = new Logger(TreasureBoxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: TreasureConfigurationService,
  ) {}

  /**
   * Retrieves or creates an active session for a given room.
   */
  async getOrCreateActiveSession(roomId: string, contextType: string = 'AUDIO_ROOM') {
    let session = await this.prisma.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    if (!session) {
      session = await this.prisma.treasureSession.create({
        data: {
          roomId,
          contextType,
          startedBy: '00000000-0000-0000-0000-000000000000',
          status: TreasureSessionStatus.ACTIVE,
          currentLevel: 1,
        },
      });

      // Initialize Box 1..5 records for this session
      const configs = await this.configService.getAllLevelConfigs();
      for (const cfg of configs) {
        await this.prisma.treasureBox.create({
          data: {
            sessionId: session.id,
            roomId,
            level: cfg.level,
            threshold: cfg.threshold,
            progress: BigInt(0),
            status: cfg.level === 1 ? TreasureBoxStatus.ACTIVE : TreasureBoxStatus.PENDING,
          },
        });
      }
    }

    return session;
  }

  /**
   * Gets the active box for a session.
   */
  async getActiveBox(sessionId: string, level: number) {
    return this.prisma.treasureBox.findUnique({
      where: {
        sessionId_level: { sessionId, level },
      },
    });
  }

  /**
   * Returns current status of all boxes in a room's active session.
   */
  async getRoomStatus(roomId: string): Promise<{
    session: any;
    boxes: BoxStatusView[];
    activeBox: BoxStatusView | null;
  }> {
    const session = await this.prisma.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    if (!session) {
      return { session: null, boxes: [], activeBox: null };
    }

    const boxes = await this.prisma.treasureBox.findMany({
      where: { sessionId: session.id },
      orderBy: { level: 'asc' },
    });

    const formattedBoxes: BoxStatusView[] = boxes.map((b) => ({
      id: b.id,
      sessionId: b.sessionId,
      roomId: b.roomId,
      level: b.level,
      threshold: b.threshold.toString(),
      progress: b.progress.toString(),
      status: b.status,
      openedAt: b.openedAt,
    }));

    const activeBox = formattedBoxes.find((b) => b.level === session.currentLevel) ?? null;

    return {
      session: {
        id: session.id,
        roomId: session.roomId,
        currentLevel: session.currentLevel,
        status: session.status,
        createdAt: session.createdAt,
      },
      boxes: formattedBoxes,
      activeBox,
    };
  }

  /**
   * Updates box status (ACTIVE, UNLOCKING, OPENED, REWARD_DISTRIBUTED, RESET).
   */
  async updateBoxStatus(boxId: string, status: TreasureBoxStatus, openedAt?: Date) {
    return this.prisma.treasureBox.update({
      where: { id: boxId },
      data: {
        status,
        ...(openedAt ? { openedAt } : {}),
      },
    });
  }
}
