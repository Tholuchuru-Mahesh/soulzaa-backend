import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface FamilyConfig {
  maxMembers: number;
  creationCost: number;
  defaultRole: string;
  autoApprove: boolean;
  joinCooldownSeconds: number;
  renameCost: number;
}

@Injectable()
export class FamilyConfigurationService {
  private readonly logger = new Logger(FamilyConfigurationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformConfig: ConfigurationEngineService,
  ) {}

  /**
   * Retrieves active family configuration from Platform Configuration.
   */
  async getFamilyConfig(): Promise<FamilyConfig> {
    try {
      const maxMem = (await this.platformConfig.get<number>('family.max_members')) ?? 100;
      const cost = (await this.platformConfig.get<number>('family.creation_cost')) ?? 1000;
      const role = (await this.platformConfig.get<string>('family.default_role')) ?? 'MEMBER';
      const autoApprove = (await this.platformConfig.get<boolean>('family.auto_approve')) ?? false;
      const cooldown = (await this.platformConfig.get<number>('family.join_cooldown')) ?? 86400;
      const renameCost = (await this.platformConfig.get<number>('family.rename_cost')) ?? 500;

      return {
        maxMembers: maxMem,
        creationCost: cost,
        defaultRole: role,
        autoApprove,
        joinCooldownSeconds: cooldown,
        renameCost,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch dynamic family config, using fallbacks: ${(err as Error).message}`,
      );
      return {
        maxMembers: 100,
        creationCost: 1000,
        defaultRole: 'MEMBER',
        autoApprove: false,
        joinCooldownSeconds: 86400,
        renameCost: 500,
      };
    }
  }

  /**
   * Upsert family configuration parameter (Admin path).
   */
  async updateConfigParameter(key: string, value: any) {
    return this.prisma.familyConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}
