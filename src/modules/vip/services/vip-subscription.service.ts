import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { WalletTxnReason } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VipAuditService } from './vip-audit.service';
import { VipConfigurationService } from './vip-configuration.service';
import { VipEventService } from './vip-event.service';
import { VipStatisticsService } from './vip-statistics.service';
import { VipTierService } from './vip-tier.service';
import { VipValidationService } from './vip-validation.service';

export interface PurchaseVipInput {
  userId: string;
  level: number;
  autoRenew?: boolean;
}

export interface GiftVipInput {
  gifterUserId: string;
  recipientUserId: string;
  level: number;
}

@Injectable()
export class VipSubscriptionService {
  private readonly logger = new Logger(VipSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly configService: VipConfigurationService,
    private readonly tierService: VipTierService,
    private readonly validationService: VipValidationService,
    private readonly statisticsService: VipStatisticsService,
    private readonly auditService: VipAuditService,
    private readonly eventService: VipEventService,
    @Inject(WALLET_SERVICE) private readonly walletService: IWalletService,
  ) {}

  /**
   * Purchases a new VIP subscription with double-entry coin debit under lock.
   */
  async purchaseVip(input: PurchaseVipInput) {
    const { userId, level, autoRenew } = input;
    const lockKey = `vip:purchase:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      // 1. Validate Tier
      const tier = await this.validationService.validateTier(level);

      // 2. Check existing active membership
      const existing = await this.prisma.vipMembership.findUnique({
        where: { userId },
      });

      if (existing && existing.status === 'ACTIVE' && existing.expiresAt > new Date()) {
        throw new BadRequestException(
          `User already has an active VIP ${existing.level} membership. Use renew or upgrade endpoint.`,
        );
      }

      // 3. Debit Coins from User Wallet via IWalletService
      const coinCost = tier.price;
      if (coinCost > BigInt(0)) {
        await this.walletService.debit({
          userId,
          currency: 'GOLD',
          amount: Number(coinCost),
          reason: WalletTxnReason.VIP_PURCHASE,
          idempotencyKey: `vip:purchase:${userId}:${level}:${Date.now()}`,
          metadata: { level, tierId: tier.id },
        });
      }

      const durationDays = tier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      // 4. Create or update membership & subscription ledger record inside transaction
      const membership = await this.prisma.$transaction(async (tx) => {
        const createdSub = await tx.vipSubscription.create({
          data: {
            userId,
            tierId: tier.id,
            pricePaid: coinCost,
            action: 'PURCHASE',
            durationDays,
            startedAt,
            expiresAt,
          },
        });

        const m = await tx.vipMembership.upsert({
          where: { userId },
          update: {
            tierId: tier.id,
            level: tier.level,
            status: 'ACTIVE',
            autoRenew: autoRenew ?? false,
            startedAt,
            expiresAt,
          },
          create: {
            userId,
            tierId: tier.id,
            level: tier.level,
            status: 'ACTIVE',
            autoRenew: autoRenew ?? false,
            startedAt,
            expiresAt,
          },
        });

        await tx.vipHistory.create({
          data: {
            userId,
            action: 'VIP_PURCHASED',
            details: {
              level: tier.level,
              subscriptionId: createdSub.id,
              pricePaid: coinCost.toString(),
            },
          },
        });

        return m;
      });

      // 5. Update Stats, Log Audit & Publish Event
      await this.statisticsService.updateStatistics('PURCHASE', coinCost);
      await this.auditService.logAudit('VIP_CREATED', userId, {
        level: tier.level,
        price: coinCost.toString(),
      });
      await this.eventService.publishVipEvent('vip.created', {
        userId,
        level: tier.level,
        expiresAt,
      });

      return {
        ...membership,
        expGained: membership.expGained.toString(),
        totalSpent: membership.totalSpent.toString(),
      };
    });
  }

  /**
   * Renews an existing active VIP membership, extending expiration date.
   */
  async renewVip(userId: string) {
    const lockKey = `vip:renew:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      const membership = await this.validationService.validateActiveMembership(userId);
      const tier = await this.validationService.validateTier(membership.level);

      const coinCost = tier.price;
      if (coinCost > BigInt(0)) {
        await this.walletService.debit({
          userId,
          currency: 'GOLD',
          amount: Number(coinCost),
          reason: WalletTxnReason.VIP_RENEWAL,
          idempotencyKey: `vip:renew:${userId}:${membership.level}:${Date.now()}`,
          metadata: { level: membership.level, tierId: tier.id },
        });
      }

      const durationDays = tier.durationDays || 30;
      const currentExpiry = new Date(membership.expiresAt).getTime();
      const newExpiry = new Date(Math.max(Date.now(), currentExpiry) + durationDays * 86400 * 1000);

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.vipSubscription.create({
          data: {
            userId,
            tierId: tier.id,
            pricePaid: coinCost,
            action: 'RENEW',
            durationDays,
            startedAt: new Date(),
            expiresAt: newExpiry,
          },
        });

        const m = await tx.vipMembership.update({
          where: { id: membership.id },
          data: {
            expiresAt: newExpiry,
            status: 'ACTIVE',
          },
        });

        await tx.vipHistory.create({
          data: {
            userId,
            action: 'VIP_RENEWED',
            details: { newExpiresAt: newExpiry },
          },
        });

        return m;
      });

      await this.statisticsService.updateStatistics('RENEW', coinCost);
      await this.auditService.logAudit('VIP_RENEWED', userId, { newExpiresAt: newExpiry });
      await this.eventService.publishVipEvent('vip.renewed', {
        userId,
        level: tier.level,
        expiresAt: newExpiry,
      });

      return {
        ...updated,
        expGained: updated.expGained.toString(),
        totalSpent: updated.totalSpent.toString(),
      };
    });
  }

  /**
   * Upgrades an active VIP membership to a higher level.
   */
  async upgradeVip(userId: string, targetLevel: number) {
    const lockKey = `vip:upgrade:${userId}`;

    return this.locks.withLock(lockKey, async () => {
      const membership = await this.validationService.validateActiveMembership(userId);
      this.validationService.validateUpgrade(membership.level, targetLevel);

      const targetTier = await this.validationService.validateTier(targetLevel);

      const coinCost = targetTier.price;
      if (coinCost > BigInt(0)) {
        await this.walletService.debit({
          userId,
          currency: 'GOLD',
          amount: Number(coinCost),
          reason: WalletTxnReason.VIP_PURCHASE,
          idempotencyKey: `vip:upgrade:${userId}:${targetLevel}:${Date.now()}`,
          metadata: { fromLevel: membership.level, toLevel: targetLevel },
        });
      }

      const durationDays = targetTier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.vipSubscription.create({
          data: {
            userId,
            tierId: targetTier.id,
            pricePaid: coinCost,
            action: 'UPGRADE',
            durationDays,
            startedAt,
            expiresAt,
          },
        });

        const m = await tx.vipMembership.update({
          where: { id: membership.id },
          data: {
            tierId: targetTier.id,
            level: targetLevel,
            status: 'ACTIVE',
            startedAt,
            expiresAt,
          },
        });

        await tx.vipHistory.create({
          data: {
            userId,
            action: 'VIP_UPGRADED',
            details: { fromLevel: membership.level, toLevel: targetLevel },
          },
        });

        return m;
      });

      await this.statisticsService.updateStatistics('UPGRADE', coinCost);
      await this.auditService.logAudit('VIP_UPGRADED', userId, {
        fromLevel: membership.level,
        toLevel: targetLevel,
      });
      await this.eventService.publishVipEvent('vip.upgraded', {
        userId,
        fromLevel: membership.level,
        toLevel: targetLevel,
      });

      return {
        ...updated,
        expGained: updated.expGained.toString(),
        totalSpent: updated.totalSpent.toString(),
      };
    });
  }

  /**
   * Gifts VIP membership to another user.
   */
  async giftVip(input: GiftVipInput) {
    const { gifterUserId, recipientUserId, level } = input;
    const lockKey = `vip:gift:${recipientUserId}`;

    return this.locks.withLock(lockKey, async () => {
      const tier = await this.validationService.validateTier(level);

      const coinCost = tier.price;
      if (coinCost > BigInt(0)) {
        await this.walletService.debit({
          userId: gifterUserId,
          currency: 'GOLD',
          amount: Number(coinCost),
          reason: WalletTxnReason.VIP_PURCHASE,
          idempotencyKey: `vip:gift:${gifterUserId}:${recipientUserId}:${level}:${Date.now()}`,
          metadata: { level, recipientUserId },
        });
      }

      const durationDays = tier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      const membership = await this.prisma.$transaction(async (tx) => {
        await tx.vipSubscription.create({
          data: {
            userId: recipientUserId,
            tierId: tier.id,
            pricePaid: coinCost,
            action: 'GIFT',
            gifterUserId,
            durationDays,
            startedAt,
            expiresAt,
          },
        });

        const m = await tx.vipMembership.upsert({
          where: { userId: recipientUserId },
          update: {
            tierId: tier.id,
            level: tier.level,
            status: 'ACTIVE',
            startedAt,
            expiresAt,
          },
          create: {
            userId: recipientUserId,
            tierId: tier.id,
            level: tier.level,
            status: 'ACTIVE',
            startedAt,
            expiresAt,
          },
        });

        await tx.vipHistory.create({
          data: {
            userId: recipientUserId,
            action: 'VIP_GIFTED',
            details: { gifterUserId, level: tier.level },
          },
        });

        return m;
      });

      await this.statisticsService.updateStatistics('PURCHASE', coinCost);
      await this.auditService.logAudit('VIP_CREATED', recipientUserId, {
        giftedBy: gifterUserId,
        level: tier.level,
      });
      await this.eventService.publishVipEvent('vip.created', {
        userId: recipientUserId,
        level: tier.level,
        giftedBy: gifterUserId,
      });

      return {
        ...membership,
        expGained: membership.expGained.toString(),
        totalSpent: membership.totalSpent.toString(),
      };
    });
  }
}
