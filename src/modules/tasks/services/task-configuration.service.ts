import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { TASK_CONFIG_KEYS } from '../constants/task.constants';

export interface TaskConfigParameters {
  dailyResetTime: string;
  weeklyResetDay: string;
  maxProgress: number;
  rewardClaimWindowDays: number;
  autoClaim: boolean;
}

@Injectable()
export class TaskConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  async getParameters(): Promise<TaskConfigParameters> {
    const [dailyReset, weeklyReset, maxProgress, rewardWindow, autoClaim] =
      await Promise.all([
        this.configEngine.get(TASK_CONFIG_KEYS.DAILY_RESET),
        this.configEngine.get(TASK_CONFIG_KEYS.WEEKLY_RESET),
        this.configEngine.get(TASK_CONFIG_KEYS.MAX_PROGRESS),
        this.configEngine.get(TASK_CONFIG_KEYS.REWARD_CLAIM_WINDOW),
        this.configEngine.get(TASK_CONFIG_KEYS.AUTO_CLAIM),
      ]);

    return {
      dailyResetTime: String(dailyReset ?? '00:00'),
      weeklyResetDay: String(weeklyReset ?? 'MON'),
      maxProgress: Number(maxProgress ?? 1000000),
      rewardClaimWindowDays: Number(rewardWindow ?? 30),
      autoClaim: Boolean(autoClaim ?? true),
    };
  }

  async setConfiguration(key: string, value: any, actorId: string) {
    const config = await this.prisma.taskConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await this.prisma.taskAudit.create({
      data: {
        actorId,
        action: 'TASK_CONFIGURATION_UPDATED',
        details: { key, value },
      },
    });

    return config;
  }

  async listConfigurations() {
    return this.prisma.taskConfiguration.findMany();
  }
}
