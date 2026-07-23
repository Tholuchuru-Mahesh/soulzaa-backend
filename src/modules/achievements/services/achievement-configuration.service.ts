import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { ACHIEVEMENT_CONFIG_KEYS } from '../constants/achievement.constants';

export interface AchievementConfigParameters {
  maxProgress: number;
  autoClaim: boolean;
  badgeDefaultVisibility: string;
  rewardClaimWindowDays: number;
}

@Injectable()
export class AchievementConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  async getParameters(): Promise<AchievementConfigParameters> {
    const maxProgress =
      (await this.configEngine.get(ACHIEVEMENT_CONFIG_KEYS.MAX_PROGRESS)) ?? 10000;
    const autoClaim = (await this.configEngine.get(ACHIEVEMENT_CONFIG_KEYS.AUTO_CLAIM)) ?? true;
    const badgeDefaultVisibility =
      (await this.configEngine.get(ACHIEVEMENT_CONFIG_KEYS.BADGE_DEFAULT_VISIBILITY)) ?? 'PUBLIC';
    const rewardClaimWindowDays =
      (await this.configEngine.get(ACHIEVEMENT_CONFIG_KEYS.REWARD_CLAIM_WINDOW)) ?? 30;

    return {
      maxProgress: Number(maxProgress),
      autoClaim: Boolean(autoClaim),
      badgeDefaultVisibility: String(badgeDefaultVisibility),
      rewardClaimWindowDays: Number(rewardClaimWindowDays),
    };
  }

  async setConfiguration(key: string, value: any, actorId: string) {
    const config = await this.prisma.achievementConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await this.prisma.achievementAudit.create({
      data: {
        actorId,
        action: 'ACHIEVEMENT_CONFIGURATION_UPDATED',
        details: { key, value },
      },
    });

    return config;
  }

  async listConfigurations() {
    return this.prisma.achievementConfiguration.findMany();
  }
}
