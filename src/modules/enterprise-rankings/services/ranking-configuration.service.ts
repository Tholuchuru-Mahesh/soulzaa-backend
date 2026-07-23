import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { RANKING_CONFIG_KEYS } from '../constants/ranking.constants';

export interface RankingConfigParameters {
  refreshIntervalSeconds: number;
  snapshotIntervalSeconds: number;
  maxEntries: number;
  scoreDecayEnabled: boolean;
  defaultVisibility: string;
}

@Injectable()
export class RankingConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  async getParameters(): Promise<RankingConfigParameters> {
    const [refreshInterval, snapshotInterval, maxEntries, scoreDecay, defaultVisibility] =
      await Promise.all([
        this.configEngine.get(RANKING_CONFIG_KEYS.REFRESH_INTERVAL),
        this.configEngine.get(RANKING_CONFIG_KEYS.SNAPSHOT_INTERVAL),
        this.configEngine.get(RANKING_CONFIG_KEYS.MAX_ENTRIES),
        this.configEngine.get(RANKING_CONFIG_KEYS.SCORE_DECAY),
        this.configEngine.get(RANKING_CONFIG_KEYS.DEFAULT_VISIBILITY),
      ]);

    return {
      refreshIntervalSeconds: Number(refreshInterval ?? 300),
      snapshotIntervalSeconds: Number(snapshotInterval ?? 86400),
      maxEntries: Number(maxEntries ?? 1000),
      scoreDecayEnabled: Boolean(scoreDecay ?? false),
      defaultVisibility: String(defaultVisibility ?? 'PUBLIC'),
    };
  }

  async setConfiguration(key: string, value: any, actorId: string) {
    const config = await this.prisma.rankingConfiguration.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });

    await this.prisma.rankingAudit.create({
      data: {
        actorId,
        action: 'RANKING_CONFIGURATION_UPDATED',
        details: { key, value },
      },
    });

    return config;
  }

  async listConfigurations() {
    return this.prisma.rankingConfiguration.findMany();
  }
}
