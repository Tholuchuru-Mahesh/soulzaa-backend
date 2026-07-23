import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { EVENT_CONFIG_KEYS } from '../constants/event.constants';

export interface EventConfigParameters {
  maxParticipants: number;
  registrationDurationHours: number;
  defaultVisibility: string;
  rewardClaimWindowDays: number;
  autoArchiveDays: number;
}

@Injectable()
export class EventConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  async getParameters(): Promise<EventConfigParameters> {
    const [maxParticipants, regDuration, defaultVis, rewardWindow, autoArchive] =
      await Promise.all([
        this.configEngine.get(EVENT_CONFIG_KEYS.MAX_PARTICIPANTS),
        this.configEngine.get(EVENT_CONFIG_KEYS.REGISTRATION_DURATION),
        this.configEngine.get(EVENT_CONFIG_KEYS.DEFAULT_VISIBILITY),
        this.configEngine.get(EVENT_CONFIG_KEYS.REWARD_CLAIM_WINDOW),
        this.configEngine.get(EVENT_CONFIG_KEYS.AUTO_ARCHIVE_DAYS),
      ]);

    return {
      maxParticipants: Number(maxParticipants ?? 1000),
      registrationDurationHours: Number(regDuration ?? 24),
      defaultVisibility: String(defaultVis ?? 'PUBLIC'),
      rewardClaimWindowDays: Number(rewardWindow ?? 30),
      autoArchiveDays: Number(autoArchive ?? 90),
    };
  }

  async setConfiguration(key: string, value: any, actorId: string) {
    const config = await this.prisma.eventConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await this.prisma.eventAudit.create({
      data: {
        actorId,
        action: 'EVENT_CONFIGURATION_UPDATED',
        details: { key, value },
      },
    });

    return config;
  }

  async listConfigurations() {
    return this.prisma.eventConfiguration.findMany();
  }
}
