import { Injectable, Logger } from '@nestjs/common';
import { TreasureBoxStatus, TreasureSessionStatus } from '@prisma/client';
import { currentIsoWeekKeyUtc, isoWeekWindowUtc } from 'src/common/utils/iso-week.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TreasureConfigurationService } from './treasure-configuration.service';

export interface BoxStatusView {
  id: string;
  sessionId: string;
  roomId: string;
  level: number;
  threshold: number | string;
  progress: number | string;
  status: TreasureBoxStatus | string;
  topGifters?: any;
  rewards?: any;
  openedAt?: Date | string | null;
}

@Injectable()
export class TreasureBoxService {
  private readonly logger = new Logger(TreasureBoxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: TreasureConfigurationService,
  ) {}

  /**
   * The room's contribution figure for the *current* ISO week (Monday 00:00 UTC).
   * Seeds the app so a joiner sees the real number instead of 0-until-first-gift.
   */
  async getRoomWeekContribution(
    roomId: string,
  ): Promise<{ roomWeekTotal: number; weekKey: string; weekStart: string; weekEnd: string }> {
    const weekKey = currentIsoWeekKeyUtc();
    const { start, end } = isoWeekWindowUtc(weekKey);
    const row = await this.prisma.roomWeeklyContribution.findUnique({
      where: { roomId_weekKey: { roomId, weekKey } },
    });
    return {
      roomWeekTotal: Number(row?.amount ?? 0n),
      weekKey,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
    };
  }

  /**
   * Retrieves or creates an active session for a given room.
   * Ensures only 1 session per day (if completed today, returns null).
   */
  async getOrCreateActiveSession(roomId: string, contextType: string = 'AUDIO_ROOM') {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let session = await this.prisma.treasureSession.findFirst({
      where: { roomId, status: TreasureSessionStatus.ACTIVE },
    });

    if (!session) {
      // If completed today, do not auto-start another session today
      const completedToday = await this.prisma.treasureSession.findFirst({
        where: {
          roomId,
          status: TreasureSessionStatus.COMPLETED,
          createdAt: { gte: todayStart },
        },
      });
      if (completedToday) {
        return null;
      }

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
   * Returns current treasure status for a room.
   *
   * Three possible states:
   *  1. ACTIVE session today → active:true, completed:false
   *  2. COMPLETED session today → active:false, completed:true (boxes still visible)
   *  3. No session today → active:false, completed:false (next event not started)
   *
   * Automatically initializes today's daily session if not started or completed.
   */
  async getRoomStatus(roomId: string): Promise<{
    active: boolean;
    completed: boolean;
    completedAt: string | null;
    sessionId: string | null;
    currentLevel: number;
    session: any;
    boxes: BoxStatusView[];
    activeBox: BoxStatusView | null;
    contribution: {
      roomWeekTotal: number;
      weekKey: string;
      weekStart: string;
      weekEnd: string;
    };
    message?: string;
  }> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Current-week room contribution — seeds the app on join (independent of
    // whether a treasure session exists), so the "Contrib" figure is never a
    // stale 0 waiting for the first live gift.
    const contribution = await this.getRoomWeekContribution(roomId);

    // 1. Get or auto-start today's active session if not completed today
    let activeSession = await this.prisma.treasureSession.findFirst({
      where: { roomId, status: 'ACTIVE' },
    });

    if (!activeSession) {
      activeSession = await this.getOrCreateActiveSession(roomId);
    }

    if (activeSession) {
      const [boxes, configs, rewardViews] = await Promise.all([
        this.prisma.treasureBox.findMany({
          where: { sessionId: activeSession.id },
          orderBy: { level: 'asc' },
        }),
        this.configService.getAllLevelConfigs(),
        this.configService.getAllLevelRewardViews(),
      ]);

      const configMap = new Map(configs.map((c) => [c.level, c]));
      const rewardsByLevel = new Map(rewardViews.map((v) => [v.level, v.rewards]));

      const formattedBoxes = boxes.map((b) => {
        const liveCfg = configMap.get(b.level);
        const threshold =
          b.status === 'OPENED'
            ? Number(b.threshold)
            : liveCfg
              ? Number(liveCfg.threshold)
              : Number(b.threshold);
        return {
          id: b.id,
          sessionId: b.sessionId,
          roomId: b.roomId,
          level: b.level,
          threshold,
          progress: Number(b.progress),
          status: b.status,
          topGifters: (b.topGifters as any) ?? [],
          rewards: rewardsByLevel.get(b.level) ?? [],
          openedAt: b.openedAt ? b.openedAt.toISOString() : null,
        };
      });

      const activeBox = formattedBoxes.find((b) => b.level === activeSession.currentLevel) ?? null;

      return {
        active: true,
        completed: false,
        completedAt: null,
        sessionId: activeSession.id,
        currentLevel: activeSession.currentLevel,
        session: {
          id: activeSession.id,
          roomId: activeSession.roomId,
          currentLevel: activeSession.currentLevel,
          status: activeSession.status,
          createdAt: activeSession.createdAt,
          completedAt: null,
        },
        boxes: formattedBoxes,
        activeBox,
        contribution,
      };
    }

    // 2. Check for a COMPLETED session created today
    const completedToday = await this.prisma.treasureSession.findFirst({
      where: {
        roomId,
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (completedToday) {
      const [boxes, rewardViews] = await Promise.all([
        this.prisma.treasureBox.findMany({
          where: { sessionId: completedToday.id },
          orderBy: { level: 'asc' },
        }),
        this.configService.getAllLevelRewardViews(),
      ]);
      const rewardsByLevel = new Map(rewardViews.map((v) => [v.level, v.rewards]));

      const formattedBoxes = boxes.map((b) => ({
        id: b.id,
        sessionId: b.sessionId,
        roomId: b.roomId,
        level: b.level,
        threshold: Number(b.threshold),
        progress: Number(b.progress),
        status: b.status,
        topGifters: (b.topGifters as any) ?? [],
        rewards: rewardsByLevel.get(b.level) ?? [],
        openedAt: b.openedAt ? b.openedAt.toISOString() : null,
      }));

      return {
        active: false,
        completed: true,
        completedAt: completedToday.completedAt?.toISOString() ?? new Date().toISOString(),
        sessionId: completedToday.id,
        currentLevel: 5,
        session: {
          id: completedToday.id,
          roomId: completedToday.roomId,
          currentLevel: 5,
          status: completedToday.status,
          createdAt: completedToday.createdAt,
          completedAt: completedToday.completedAt?.toISOString() ?? null,
        },
        boxes: formattedBoxes,
        activeBox: null,
        contribution,
        message:
          "🎁 Today's Treasure Event has been completed. The next Treasure Event will start tomorrow.",
      };
    }

    // 3. No session today — event not started yet
    return {
      active: false,
      completed: false,
      completedAt: null,
      sessionId: null,
      currentLevel: 0,
      session: null,
      boxes: [],
      activeBox: null,
      contribution,
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
