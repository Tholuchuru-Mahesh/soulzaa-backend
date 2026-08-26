import { Injectable } from '@nestjs/common';
import { currentPeriodKey } from '../constants/wealth.constants';
import type { IWealthService, WealthStatusView } from '../interfaces/wealth.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthLevelService } from './wealth-level.service';

/**
 * Read side of the Wealth Level module — the sanctioned cross-module
 * contract (`IWealthService`) plus the richer status view backing the user
 * API. A user with no progress row yet is Normal User / 0 EXP for the
 * current month, not an error.
 */
@Injectable()
export class WealthProgressService implements IWealthService {
  constructor(
    private readonly repo: WealthRepository,
    private readonly levels: WealthLevelService,
  ) {}

  async getEffectiveLevel(userId: string): Promise<number> {
    const progress = await this.repo.getProgress(userId);
    if (!progress || progress.periodKey !== currentPeriodKey()) return progress?.currentLevel ?? 0;
    return progress.currentLevel;
  }

  async getStatus(userId: string): Promise<WealthStatusView> {
    const periodKey = currentPeriodKey();
    const progress = await this.repo.getProgress(userId);
    const isCurrentMonth = progress?.periodKey === periodKey;

    const level = isCurrentMonth ? progress!.currentLevel : (progress?.currentLevel ?? 0);
    const exp = isCurrentMonth ? Number(progress!.currentExp) : 0;

    const levelDef = this.levels.getByOrdinal(level);
    const next = this.levels.nextLevel(level);

    const nextLevelExp = next ? Number(next.expThreshold) : null;
    const remainingExp = nextLevelExp !== null ? Math.max(0, nextLevelExp - exp) : null;
    const currentThreshold = levelDef ? Number(levelDef.expThreshold) : 0;
    const progressPct =
      nextLevelExp !== null && nextLevelExp > currentThreshold
        ? Math.min(100, Math.max(0, ((exp - currentThreshold) / (nextLevelExp - currentThreshold)) * 100))
        : level > 0
          ? 100
          : 0;

    return {
      userId,
      level,
      levelName: levelDef?.name ?? 'Normal User',
      currentExp: exp,
      periodKey,
      nextLevel: next?.level ?? null,
      nextLevelName: next?.name ?? null,
      nextLevelExp,
      remainingExp,
      progressPct,
    };
  }
}
