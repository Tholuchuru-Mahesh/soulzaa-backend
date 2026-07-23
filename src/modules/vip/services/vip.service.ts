import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BackpackItemSource } from '@prisma/client';
import { VipLevel } from 'src/common/enums/vip-level.enum';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import {
  VIP_LEVEL_ORDER,
  vipLockKey,
  vipOrdinal,
  type VipBenefit,
} from '../constants/vip.constants';
import { VipUpgradedEvent } from '../events/vip.events';
import type { IVipService, VipStatusView } from '../interfaces/vip.service.interface';
import { VipRepository } from '../repositories/vip.repository';

const CONFIG_RELOAD_MS = 300_000;

/**
 * VIP membership (AR-7). Lifetime Gold-coin recharge accrues under a per-user
 * lock (idempotent on the recharge key); crossing a tier threshold auto-upgrades
 * and grants every crossed tier's benefit cosmetics (badge/frame/entrance-effect
 * via the backpack) exactly once, logs the upgrade immutably, and publishes an
 * upgrade event. Tier configs are cached in-memory and refreshed on a timer / on
 * admin change.
 */
@Injectable()
export class VipService implements IVipService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VipService.name);
  private configs: any[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: VipRepository,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch(() => undefined), CONFIG_RELOAD_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reload(): Promise<void> {
    this.configs = await this.repo.listConfigs();
  }

  // ---- IVipService ----

  async getStatus(userId: string): Promise<VipStatusView> {
    const row = await this.repo.getStatus(userId);
    const level = row?.level ?? VipLevel.NONE;
    const lifetimeRecharge = Number(row?.lifetimeRecharge ?? 0n);
    const next = this.nextTier(level);
    return {
      userId,
      level,
      ordinal: vipOrdinal(level),
      lifetimeRecharge,
      nextLevel: next?.level ?? null,
      nextLevelRecharge: next ? Number(next.minRecharge) : null,
    };
  }

  async getLevelOrdinal(userId: string): Promise<number> {
    const row = await this.repo.getStatus(userId);
    return vipOrdinal(row?.level ?? VipLevel.NONE);
  }

  async recordRecharge(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
  }): Promise<{ level: VipLevel; upgraded: boolean }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BusinessException(
        ERROR_CODES.INVALID_AMOUNT,
        'Recharge amount must be a positive integer.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.locks.withLock(vipLockKey(input.userId), async () => {
      if (await this.repo.findRechargeLog(input.idempotencyKey)) {
        const current = await this.repo.getStatus(input.userId);
        return { level: current?.level ?? VipLevel.NONE, upgraded: false };
      }

      const current = await this.repo.getStatus(input.userId);
      const oldLevel = current?.level ?? VipLevel.NONE;
      const newTotal = (current?.lifetimeRecharge ?? 0n) + BigInt(input.amount);
      const newLevel = this.tierForRecharge(newTotal);

      await this.repo.applyRecharge({
        userId: input.userId,
        amount: BigInt(input.amount),
        idempotencyKey: input.idempotencyKey,
        newLevel,
      });

      const upgraded = vipOrdinal(newLevel) > vipOrdinal(oldLevel);
      if (upgraded) {
        const granted = await this.grantTierBenefits(input.userId, oldLevel, newLevel);
        await this.repo.logUpgrade({
          userId: input.userId,
          fromLevel: oldLevel,
          toLevel: newLevel,
          lifetimeRecharge: newTotal,
        });
        await this.bus.publish(
          new VipUpgradedEvent({
            userId: input.userId,
            fromLevel: oldLevel,
            toLevel: newLevel,
            lifetimeRecharge: Number(newTotal),
            grantedCosmeticIds: granted,
          }),
        );
      }
      return { level: newLevel, upgraded };
    });
  }

  // ---- Internals ----

  private nextTier(level: VipLevel): any | null {
    const ord = vipOrdinal(level);
    const higher = this.configs
      .filter((c) => vipOrdinal(c.level) > ord)
      .sort((a, b) => vipOrdinal(a.level) - vipOrdinal(b.level));
    return higher[0] ?? null;
  }

  /** Highest configured tier whose `minRecharge` ≤ total; defaults to NONE. */
  private tierForRecharge(total: bigint): VipLevel {
    let best: VipLevel = VipLevel.NONE;
    for (const c of this.configs) {
      if (total >= c.minRecharge && vipOrdinal(c.level) > vipOrdinal(best)) best = c.level;
    }
    return best;
  }

  /** Grant benefit cosmetics for every tier crossed (oldLevel, newLevel]. */
  private async grantTierBenefits(
    userId: string,
    oldLevel: VipLevel,
    newLevel: VipLevel,
  ): Promise<string[]> {
    const oldOrd = vipOrdinal(oldLevel);
    const newOrd = vipOrdinal(newLevel);
    const granted: string[] = [];
    for (const cfg of this.configs) {
      const ord = vipOrdinal(cfg.level);
      if (ord <= oldOrd || ord > newOrd) continue;
      const benefits = (cfg.benefits as unknown as VipBenefit[]) ?? [];
      for (const b of benefits) {
        if (b.kind !== 'COSMETIC' || !b.cosmeticId) continue;
        const res = await this.cosmetics.grantToUser({
          userId,
          cosmeticId: b.cosmeticId,
          source: BackpackItemSource.EVENT,
          grantKey: `vip:${userId}:${cfg.level}:${b.cosmeticId}`,
        });
        if (res) granted.push(b.cosmeticId);
      }
    }
    return granted;
  }

  /** Diagnostics: number of tier configs loaded. */
  get configuredTiers(): number {
    return this.configs.length;
  }

  /** The full VIP tier order (for admin listing). */
  get tierOrder(): VipLevel[] {
    return VIP_LEVEL_ORDER;
  }
}
