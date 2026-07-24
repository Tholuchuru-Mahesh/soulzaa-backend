import { Injectable, Logger } from '@nestjs/common';

export interface FeatureFlagRule {
  enabled: boolean;
  percentageRollout?: number;
  allowedRoles?: string[];
  allowedRegions?: string[];
}

@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly flags = new Map<string, FeatureFlagRule>();

  setFlag(flagName: string, rule: FeatureFlagRule): void {
    this.flags.set(flagName, rule);
    this.logger.log(`FeatureFlag [${flagName}] updated: ${JSON.stringify(rule)}`);
  }

  isEnabled(
    flagName: string,
    context?: { userId?: string; role?: string; region?: string },
  ): boolean {
    const rule = this.flags.get(flagName);
    if (!rule || !rule.enabled) {
      return false;
    }

    if (rule.allowedRoles && context?.role) {
      if (!rule.allowedRoles.includes(context.role)) {
        return false;
      }
    }

    if (rule.allowedRegions && context?.region) {
      if (!rule.allowedRegions.includes(context.region)) {
        return false;
      }
    }

    if (rule.percentageRollout !== undefined && rule.percentageRollout < 100) {
      if (!context?.userId) {
        return false;
      }
      const hash = this.hashString(context.userId);
      const userBucket = hash % 100;
      return userBucket < rule.percentageRollout;
    }

    return true;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
