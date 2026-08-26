import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { WealthLevel } from '@prisma/client';
import { WealthRepository } from '../repositories/wealth.repository';

const CONFIG_RELOAD_MS = 300_000;

/**
 * Caches the 13 Wealth Level threshold definitions in memory (mirrors
 * VipService/ExpService's config cache) so the purchase hot path never
 * queries level config. Refreshed on a timer and can be forced after an
 * admin edit.
 */
@Injectable()
export class WealthLevelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WealthLevelService.name);
  private levels: WealthLevel[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly repo: WealthRepository) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch(() => undefined), CONFIG_RELOAD_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    const levels = await this.repo.listLevels();
    this.levels = levels.length > 0 ? levels : this.levels;
  }

  /** All active levels, ascending. */
  list(): WealthLevel[] {
    return this.levels;
  }

  getByOrdinal(level: number): WealthLevel | null {
    return this.levels.find((l) => l.level === level) ?? null;
  }

  /** Highest configured level whose `expThreshold` <= totalExp; defaults to 0 (Normal User). */
  levelForExp(totalExp: bigint): number {
    let level = 0;
    for (const l of this.levels) {
      if (totalExp >= l.expThreshold && l.level > level) level = l.level;
    }
    return level;
  }

  nextLevel(level: number): WealthLevel | null {
    const higher = this.levels.filter((l) => l.level > level).sort((a, b) => a.level - b.level);
    return higher[0] ?? null;
  }

  maxLevel(): number {
    return this.levels.reduce((max, l) => Math.max(max, l.level), 0);
  }
}
