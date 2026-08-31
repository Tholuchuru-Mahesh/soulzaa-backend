import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemType,
  CosmeticType,
  Prisma,
  RocketConfig,
  TreasureBoxConfig,
} from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { RewardEntryDto, RocketConfigDto, TreasureConfigDto } from '../dto/treasure.dto';
import { TREASURE_REWARD_ITEM_TYPES } from '../dto/treasure.dto';
import { RocketRepository } from '../repositories/rocket.repository';
import { TreasureRepository } from '../repositories/treasure.repository';

/** Reward item types map 1:1 to catalog cosmetic types (same member names). */
const ITEM_TYPE_TO_COSMETIC_TYPE: Partial<Record<BackpackItemType, CosmeticType>> = {
  [BackpackItemType.FRAME]: CosmeticType.FRAME,
  [BackpackItemType.THEME]: CosmeticType.THEME,
  [BackpackItemType.ENTRANCE_EFFECT]: CosmeticType.ENTRANCE_EFFECT,
};

/**
 * Platform-admin configuration of the treasure box ladder (5 levels: thresholds
 * + ranked reward lists) and the rocket configs (per trigger gift: duration +
 * reward pool). Every non-coin reward must reference an existing enabled catalog
 * cosmetic — the panel picks from live assets and this service re-verifies the
 * link + derives the display name so nothing is ever a hardcoded placeholder.
 * Mutations invalidate nothing cached — the runtime reads configs from the DB at
 * session start / box open / rocket completion.
 */
@Injectable()
export class TreasureAdminService {
  constructor(
    private readonly treasure: TreasureRepository,
    private readonly rocket: RocketRepository,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  listTreasureConfigs(): Promise<TreasureBoxConfig[]> {
    return this.treasure.listConfigs();
  }

  async upsertTreasureConfig(actorId: string, dto: TreasureConfigDto): Promise<TreasureBoxConfig> {
    const rewards = await this.resolveRewards(dto.rewards);
    return this.treasure.upsertConfig(
      dto.level,
      {
        threshold: BigInt(dto.threshold),
        rewards: rewards as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
      },
      actorId,
    );
  }

  listRocketConfigs(): Promise<RocketConfig[]> {
    return this.rocket.listConfigs();
  }

  async upsertRocketConfig(actorId: string, dto: RocketConfigDto): Promise<RocketConfig> {
    const rewardPool = await this.resolveRewards(dto.rewardPool);
    return this.rocket.upsertConfig(
      dto.triggerGiftId,
      {
        durationSeconds: dto.durationSeconds,
        priority: dto.priority ?? 0,
        rewardPool: rewardPool as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
      },
      actorId,
    );
  }

  /**
   * Verifies every reward entry and returns a normalised list safe to persist:
   * COINS entries keep only `{rank, kind, coins}`; BACKPACK_ITEM entries are
   * bound to a live enabled catalog cosmetic of the matching type, with the
   * display name taken from the catalog (never client-supplied text). A rank may
   * carry more than one reward entry — the winner receives all of them.
   */
  private async resolveRewards(entries: RewardEntryDto[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === 'COINS') {
        if (!entry.coins || entry.coins <= 0) {
          throw new BusinessException(
            ERROR_CODES.VALIDATION_ERROR,
            `Rank ${entry.rank}: a coins reward needs a positive amount.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        if (seen.has(`${entry.rank}:COINS`)) {
          throw new BusinessException(
            ERROR_CODES.VALIDATION_ERROR,
            `Rank ${entry.rank}: combine the coin rewards into a single amount.`,
            HttpStatus.BAD_REQUEST,
          );
        }
        seen.add(`${entry.rank}:COINS`);
        out.push({ rank: entry.rank, kind: 'COINS', coins: Math.trunc(entry.coins) });
        continue;
      }

      const itemType = entry.itemType as BackpackItemType | undefined;
      if (!itemType || !TREASURE_REWARD_ITEM_TYPES.includes(itemType as never)) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `Rank ${entry.rank}: reward type must be one of ${TREASURE_REWARD_ITEM_TYPES.join(', ')}.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!entry.itemRefId) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `Rank ${entry.rank}: pick a catalog asset for this reward.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      const cosmetic = await this.cosmetics.getCosmetic(entry.itemRefId);
      if (!cosmetic || !cosmetic.enabled) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `Rank ${entry.rank}: the selected asset does not exist or is disabled.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (cosmetic.type !== ITEM_TYPE_TO_COSMETIC_TYPE[itemType]) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `Rank ${entry.rank}: "${cosmetic.name}" is a ${cosmetic.type}, not a ${itemType}.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (seen.has(`${entry.rank}:${cosmetic.id}`)) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `Rank ${entry.rank}: "${cosmetic.name}" is already a reward for this rank.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      seen.add(`${entry.rank}:${cosmetic.id}`);
      const ttlDays =
        entry.ttlDays !== undefined && entry.ttlDays > 0 ? Math.trunc(entry.ttlDays) : 0;
      out.push({
        rank: entry.rank,
        kind: 'BACKPACK_ITEM',
        itemType,
        itemRefId: cosmetic.id,
        itemName: cosmetic.name,
        transferable: entry.transferable ?? cosmetic.transferable ?? false,
        ttlDays,
      });
    }
    return out;
  }
}
