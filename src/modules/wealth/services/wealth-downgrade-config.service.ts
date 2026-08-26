import { Injectable } from '@nestjs/common';
import type { WealthDowngradeConfig } from '@prisma/client';
import { WealthRepository } from '../repositories/wealth.repository';

const DEFAULT_CONFIG = { enabled: true, maxDowngradeLevels: 1, minLevel: 0 };

/**
 * Super-Admin-controlled downgrade policy. `getActive` always returns a
 * usable config (falls back to a conservative default of "max 1 level down,
 * floor 0" if no policy row has ever been created) so the monthly reset job
 * never has to special-case "no config yet."
 */
@Injectable()
export class WealthDowngradeConfigService {
  constructor(private readonly repo: WealthRepository) {}

  async getActive(
    now: Date = new Date(),
  ): Promise<Pick<WealthDowngradeConfig, 'enabled' | 'maxDowngradeLevels' | 'minLevel'>> {
    const active = await this.repo.getActiveDowngradeConfig(now);
    return active ?? DEFAULT_CONFIG;
  }

  async list(): Promise<WealthDowngradeConfig[]> {
    return this.repo.listDowngradeConfigs();
  }

  async update(
    actorId: string,
    input: {
      enabled: boolean;
      maxDowngradeLevels: number;
      minLevel: number;
      effectiveFrom?: Date;
      effectiveTo?: Date | null;
    },
  ): Promise<WealthDowngradeConfig> {
    const previous = await this.repo.getActiveDowngradeConfig(new Date());
    const created = await this.repo.createDowngradeConfig({
      enabled: input.enabled,
      maxDowngradeLevels: input.maxDowngradeLevels,
      minLevel: input.minLevel,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      effectiveTo: input.effectiveTo ?? null,
      updatedBy: actorId,
    });
    await this.repo.writeAudit({
      actorId,
      action: 'WEALTH_DOWNGRADE_CONFIG_UPDATED',
      entityType: 'WealthDowngradeConfig',
      entityId: created.id,
      oldValue: previous,
      newValue: created,
    });
    return created;
  }
}
