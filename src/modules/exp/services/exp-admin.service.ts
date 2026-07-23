import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LevelConfigDto, RoomLevelConfigDto } from '../dto/exp.dto';
import { ExpRepository } from '../repositories/exp.repository';
import { ExpService } from './exp.service';

@Injectable()
export class ExpAdminService {
  constructor(
    private readonly repo: ExpRepository,
    private readonly exp: ExpService,
  ) {}

  listLevels(): Promise<any[]> {
    return this.repo.listLevelConfigs();
  }

  listRoomLevels(): Promise<any[]> {
    return this.repo.listLevelConfigs();
  }

  async upsertLevel(actorId: string, dto: LevelConfigDto): Promise<any> {
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

  async upsertRoomLevel(actorId: string, dto: RoomLevelConfigDto): Promise<any> {
    const config = await this.repo.upsertLevelConfig(
      dto.level,
      { minExp: BigInt(dto.minExp), title: dto.title ?? null, rewards: [] },
      actorId,
    );
    await this.exp.reload();
    return config;
  }
}
