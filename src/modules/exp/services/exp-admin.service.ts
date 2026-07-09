import { Injectable } from '@nestjs/common';
import { LevelConfig, Prisma, RoomLevelConfig } from '@prisma/client';
import type { LevelConfigDto, RoomLevelConfigDto } from '../dto/exp.dto';
import { ExpRepository } from '../repositories/exp.repository';
import { ExpService } from './exp.service';

/**
 * Platform-admin configuration of the user + room level ladders (thresholds +
 * rewards). Every mutation reloads the EXP service's in-memory config cache so
 * awards reflect the change immediately.
 */
@Injectable()
export class ExpAdminService {
  constructor(
    private readonly repo: ExpRepository,
    private readonly exp: ExpService,
  ) {}

  listLevels(): Promise<LevelConfig[]> {
    return this.repo.listLevelConfigs();
  }

  listRoomLevels(): Promise<RoomLevelConfig[]> {
    return this.repo.listRoomLevelConfigs();
  }

  async upsertLevel(actorId: string, dto: LevelConfigDto): Promise<LevelConfig> {
    const config = await this.repo.upsertLevelConfig(
      dto.level,
      {
        minExp: BigInt(dto.minExp),
        title: dto.title ?? null,
        rewards: (dto.rewards ?? []) as unknown as Prisma.InputJsonValue,
      },
      actorId,
    );
    await this.exp.reload();
    return config;
  }

  async upsertRoomLevel(actorId: string, dto: RoomLevelConfigDto): Promise<RoomLevelConfig> {
    const config = await this.repo.upsertRoomLevelConfig(
      dto.level,
      { minExp: BigInt(dto.minExp), title: dto.title ?? null },
      actorId,
    );
    await this.exp.reload();
    return config;
  }
}
