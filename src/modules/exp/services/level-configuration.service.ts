import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';

export interface LevelConfigParameters {
  maxLevel: number;
  defaultLevel: number;
  dailyExpLimit: number;
  weeklyExpLimit: number;
  monthlyExpLimit: number;
}

@Injectable()
export class LevelConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  async getParameters(): Promise<LevelConfigParameters> {
    const maxLevel = (await this.configEngine.get('level.max')) ?? 100;
    const defaultLevel = (await this.configEngine.get('level.default')) ?? 1;
    const dailyExpLimit = (await this.configEngine.get('exp.daily_limit')) ?? 50000;
    const weeklyExpLimit = (await this.configEngine.get('exp.weekly_limit')) ?? 300000;
    const monthlyExpLimit = (await this.configEngine.get('exp.monthly_limit')) ?? 1000000;

    return {
      maxLevel: Number(maxLevel),
      defaultLevel: Number(defaultLevel),
      dailyExpLimit: Number(dailyExpLimit),
      weeklyExpLimit: Number(weeklyExpLimit),
      monthlyExpLimit: Number(monthlyExpLimit),
    };
  }

  async setConfiguration(key: string, value: any, actorId: string) {
    const config = await this.prisma.levelConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await this.prisma.levelAudit.create({
      data: {
        actorId,
        action: 'LEVEL_CONFIGURATION_UPDATED',
        details: { key, value },
      },
    });

    return config;
  }
}
