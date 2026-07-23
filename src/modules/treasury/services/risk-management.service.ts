import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { FeatureFlagService } from 'src/modules/platform-configuration/services/feature-flag.service';
import { TreasuryAuditService } from './treasury-audit.service';
import { TreasuryService } from './treasury.service';

@Injectable()
export class RiskManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly treasuryService: TreasuryService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly auditService: TreasuryAuditService,
  ) {}

  /**
   * Retrieves current risk controls and emergency lock flags status
   */
  async getRiskControlsStatus() {
    const reserve = await this.treasuryService.getTreasuryReserve();

    const [walletEnabled, giftEnabled, economyFrozen] = await Promise.all([
      this.featureFlagService.isEnabled('feature.wallet.enabled'),
      this.featureFlagService.isEnabled('feature.gifts.enabled'),
      this.featureFlagService.isEnabled('maintenance_mode'),
    ]);

    return {
      economyFrozen: reserve.isFrozen || economyFrozen,
      walletLock: !walletEnabled,
      giftLock: !giftEnabled,
      withdrawalLock: reserve.isFrozen,
      purchaseLock: reserve.isFrozen,
      lastUpdated: reserve.updatedAt,
    };
  }

  /**
   * Triggers emergency freeze across the economy or specific financial features
   */
  async freezeEconomy(scope = 'ALL', reason?: string, actorId?: string) {
    const reserve = await this.prisma.treasuryReserve.findFirst();
    if (reserve) {
      await this.prisma.treasuryReserve.update({
        where: { id: reserve.id },
        data: { isFrozen: true, updatedBy: actorId },
      });
    }

    if (scope === 'ALL' || scope === 'WALLET') {
      await this.featureFlagService.disableFlag('feature.wallet.enabled', reason, actorId);
    }
    if (scope === 'ALL' || scope === 'GIFT') {
      await this.featureFlagService.disableFlag('feature.gifts.enabled', reason, actorId);
    }

    await this.auditService.logOperation(
      'FREEZE',
      null,
      'ACTIVE',
      'FROZEN',
      reason ?? 'Emergency Freeze Triggered',
      actorId,
    );

    return {
      message: `Emergency Freeze applied successfully (Scope: ${scope})`,
      isFrozen: true,
      reason,
      timestamp: new Date(),
    };
  }

  /**
   * Resumes normal economy operations from an emergency freeze
   */
  async resumeEconomy(scope = 'ALL', reason?: string, actorId?: string) {
    const reserve = await this.prisma.treasuryReserve.findFirst();
    if (reserve) {
      await this.prisma.treasuryReserve.update({
        where: { id: reserve.id },
        data: { isFrozen: false, updatedBy: actorId },
      });
    }

    if (scope === 'ALL' || scope === 'WALLET') {
      await this.featureFlagService.enableFlag('feature.wallet.enabled', reason, actorId);
    }
    if (scope === 'ALL' || scope === 'GIFT') {
      await this.featureFlagService.enableFlag('feature.gifts.enabled', reason, actorId);
    }

    await this.auditService.logOperation(
      'RESUME',
      null,
      'FROZEN',
      'ACTIVE',
      reason ?? 'Emergency Freeze Resumed',
      actorId,
    );

    return {
      message: `Economy operations resumed successfully (Scope: ${scope})`,
      isFrozen: false,
      reason,
      timestamp: new Date(),
    };
  }
}
