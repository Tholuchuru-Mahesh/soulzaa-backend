import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VipConfigDto } from '../dto/vip.dto';
import { VipRepository } from '../repositories/vip.repository';
import { VipService } from './vip.service';

/**
 * Platform-admin configuration of the VIP tier ladder (recharge thresholds +
 * benefits). Every mutation reloads the VIP service's in-memory config cache.
 */
@Injectable()
export class VipAdminService {
  constructor(
    private readonly repo: VipRepository,
    private readonly vip: VipService,
  ) {}

  listConfigs(): Promise<any[]> {
    return this.repo.listConfigs();
  }

  async upsertConfig(actorId: string, dto: VipConfigDto): Promise<any> {
    const config = await this.repo.upsertConfig(
      dto.level,
      {
        minRecharge: BigInt(dto.minRecharge),
        benefits: (dto.benefits ?? []) as unknown as Prisma.InputJsonValue,
      },
      actorId,
    );
    await this.vip.reload();
    return config;
  }
}
