import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ConfigurationEngineService } from './configuration-engine.service';

@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configEngine: ConfigurationEngineService,
  ) {}

  /**
   * Checks if a feature flag is enabled
   */
  async isEnabled(flagKey: string): Promise<boolean> {
    try {
      return await this.configEngine.getBoolean(flagKey, false);
    } catch {
      return false;
    }
  }

  /**
   * Enables a feature flag
   */
  async enableFlag(flagKey: string, reason?: string, actorId?: string) {
    return this.configEngine.setSetting(flagKey, 'true', reason ?? 'Feature flag enabled', actorId);
  }

  /**
   * Disables a feature flag
   */
  async disableFlag(flagKey: string, reason?: string, actorId?: string) {
    return this.configEngine.setSetting(
      flagKey,
      'false',
      reason ?? 'Feature flag disabled',
      actorId,
    );
  }

  /**
   * Toggles feature flag status
   */
  async toggleFlag(flagKey: string, explicitState?: boolean, reason?: string, actorId?: string) {
    const currentState = await this.isEnabled(flagKey);
    const targetState = explicitState !== undefined ? explicitState : !currentState;

    return targetState
      ? this.enableFlag(flagKey, reason, actorId)
      : this.disableFlag(flagKey, reason, actorId);
  }

  /**
   * List all system feature flags
   */
  async listFeatureFlags() {
    return this.prisma.platformSetting.findMany({
      where: { isFeatureFlag: true },
      orderBy: { key: 'asc' },
    });
  }
}
