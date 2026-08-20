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
   * Retrieves active family configuration from persistent configuration.
   */
  async getFamilyConfig(): Promise<FamilyConfig> {
    try {
      const allConfigs = await this.prisma.familyConfiguration.findMany();
      const configMap = new Map(allConfigs.map((c) => [c.key, c.value]));

      const maxMem = configMap.has('family.max_members')
        ? Number(configMap.get('family.max_members'))
        : ((await this.platformConfig.get<number>('family.max_members', 100).catch(() => 100)) ?? 100);

      const cost = configMap.has('family.creation_cost')
        ? Number(configMap.get('family.creation_cost'))
        : ((await this.platformConfig.get<number>('family.creation_cost', 1000).catch(() => 1000)) ?? 1000);

      const role = configMap.has('family.default_role')
        ? String(configMap.get('family.default_role'))
        : ((await this.platformConfig.get<string>('family.default_role', 'MEMBER').catch(() => 'MEMBER')) ?? 'MEMBER');

      const autoApprove = configMap.has('family.auto_approve')
        ? (configMap.get('family.auto_approve') === true || String(configMap.get('family.auto_approve')) === 'true')
        : ((await this.platformConfig.get<boolean>('family.auto_approve', false).catch(() => false)) ?? false);

      const cooldown = configMap.has('family.join_cooldown')
        ? Number(configMap.get('family.join_cooldown'))
        : ((await this.platformConfig.get<number>('family.join_cooldown', 86400).catch(() => 86400)) ?? 86400);

      const renameCost = configMap.has('family.rename_cost')
        ? Number(configMap.get('family.rename_cost'))
        : ((await this.platformConfig.get<number>('family.rename_cost', 500).catch(() => 500)) ?? 500);

      return {
        maxMembers: isNaN(maxMem) ? 100 : maxMem,
        creationCost: isNaN(cost) ? 1000 : cost,
        defaultRole: role,
        autoApprove,
        joinCooldownSeconds: isNaN(cooldown) ? 86400 : cooldown,
        renameCost: isNaN(renameCost) ? 500 : renameCost,
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
    const res = await this.prisma.familyConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    try {
      await this.platformConfig.setSetting(key, value, 'Admin update');
    } catch {
      // Ignored if platformSetting schema row not seeded
    }

    return res;
  }
}
