import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, RocketConfig, TreasureBoxConfig } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { RocketConfigDto, TreasureConfigDto } from '../dto/treasure.dto';
import { RocketRepository } from '../repositories/rocket.repository';
import { TreasureRepository } from '../repositories/treasure.repository';

/**
 * Platform-admin configuration of the treasure box ladder (5 levels: thresholds
 * + Top-3 reward lists) and the rocket configs (per trigger gift: duration +
 * reward pool). Mutations invalidate nothing cached — the runtime reads configs
 * from the DB at session start / rocket completion.
 */
@Injectable()
export class TreasureAdminService {
  constructor(
    private readonly treasure: TreasureRepository,
    private readonly rocket: RocketRepository,
  ) {}

  listTreasureConfigs(): Promise<TreasureBoxConfig[]> {
    return this.treasure.listConfigs();
  }

  upsertTreasureConfig(actorId: string, dto: TreasureConfigDto): Promise<TreasureBoxConfig> {
    this.assertRanksValid(dto.rewards.map((r) => r.rank));
    return this.treasure.upsertConfig(
      dto.level,
      {
        threshold: BigInt(dto.threshold),
        rewards: dto.rewards as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
      },
      actorId,
    );
  }

  listRocketConfigs(): Promise<RocketConfig[]> {
    return this.rocket.listConfigs();
  }

  upsertRocketConfig(actorId: string, dto: RocketConfigDto): Promise<RocketConfig> {
    this.assertRanksValid(dto.rewardPool.map((r) => r.rank));
    return this.rocket.upsertConfig(
      dto.triggerGiftId,
      {
        durationSeconds: dto.durationSeconds,
        priority: dto.priority ?? 0,
        rewardPool: dto.rewardPool as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
      },
      actorId,
    );
  }

  private assertRanksValid(ranks: number[]): void {
    if (new Set(ranks).size !== ranks.length) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Reward ranks must be unique.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
