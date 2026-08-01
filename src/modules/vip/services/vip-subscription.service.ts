import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { WalletTxnReason } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { walletLockKey } from 'src/modules/wallet/constants/wallet.constants';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { VIP_EVENTS } from '../events/vip.events';
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
    // Lock on the payer's WALLET: the debit runs inside the $transaction with a
    // `tx`, so WalletService.debit does NOT take its own lock — the caller must.
    const lockKey = walletLockKey(userId);

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

      const coinCost = tier.price;
      const durationDays = tier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      // 3+4. Debit + membership writes are ONE atomic transaction. The debit
      // joins the tx (2nd arg) so a failed membership write rolls it back. The
      // idempotency key is deterministic (bound to the membership state this
      // purchase transitions FROM) so a retry collapses to a single charge.
      const membership = await this.prisma.$transaction(async (tx) => {
        if (coinCost > BigInt(0)) {
          await this.walletService.debit(
            {
              userId,
              currency: 'GOLD',
              amount: Number(coinCost),
              reason: WalletTxnReason.VIP_PURCHASE,
              idempotencyKey: `vip:purchase:${userId}:${level}:${existing?.expiresAt?.toISOString() ?? 'new'}`,
              metadata: { level, tierId: tier.id },
            },
            tx,
          );
        }

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
      await this.eventService.publishVipEvent(VIP_EVENTS.CREATED, {
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
    const lockKey = walletLockKey(userId); // guards the tx-scoped wallet debit

    return this.locks.withLock(lockKey, async () => {
      const membership = await this.validationService.validateActiveMembership(userId);
      const tier = await this.validationService.validateTier(membership.level);

      const coinCost = tier.price;
      const durationDays = tier.durationDays || 30;
      const currentExpiry = new Date(membership.expiresAt).getTime();
      const newExpiry = new Date(Math.max(Date.now(), currentExpiry) + durationDays * 86400 * 1000);

      const updated = await this.prisma.$transaction(async (tx) => {
        if (coinCost > BigInt(0)) {
          await this.walletService.debit(
            {
              userId,
              currency: 'GOLD',
              amount: Number(coinCost),
              reason: WalletTxnReason.VIP_RENEWAL,
              // Bound to the pre-renewal expiry: stable across retries of THIS
              // renewal, unique once the expiry advances.
              idempotencyKey: `vip:renew:${userId}:${membership.level}:${new Date(membership.expiresAt).toISOString()}`,
              metadata: { level: membership.level, tierId: tier.id },
            },
            tx,
          );
        }

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
      await this.eventService.publishVipEvent(VIP_EVENTS.RENEWED, {
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
    const lockKey = walletLockKey(userId); // guards the tx-scoped wallet debit

    return this.locks.withLock(lockKey, async () => {
      const membership = await this.validationService.validateActiveMembership(userId);
      this.validationService.validateUpgrade(membership.level, targetLevel);

      const targetTier = await this.validationService.validateTier(targetLevel);

      const coinCost = targetTier.price;
      const durationDays = targetTier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      const updated = await this.prisma.$transaction(async (tx) => {
        if (coinCost > BigInt(0)) {
          await this.walletService.debit(
            {
              userId,
              currency: 'GOLD',
              amount: Number(coinCost),
              reason: WalletTxnReason.VIP_PURCHASE,
              // Bound to the from→to transition: stable across retries, unique
              // once the membership level advances.
              idempotencyKey: `vip:upgrade:${userId}:${membership.level}->${targetLevel}`,
              metadata: { fromLevel: membership.level, toLevel: targetLevel },
            },
            tx,
          );
        }

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
      await this.eventService.publishVipEvent(VIP_EVENTS.UPGRADED, {
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
    // Lock on the GIFTER's wallet — they are the debited party (payer).
    const lockKey = walletLockKey(gifterUserId);

    return this.locks.withLock(lockKey, async () => {
      const tier = await this.validationService.validateTier(level);
      const existingRecipient = await this.prisma.vipMembership.findUnique({
        where: { userId: recipientUserId },
      });

      const coinCost = tier.price;
      const durationDays = tier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      const membership = await this.prisma.$transaction(async (tx) => {
        if (coinCost > BigInt(0)) {
          await this.walletService.debit(
            {
              userId: gifterUserId,
              currency: 'GOLD',
              amount: Number(coinCost),
              reason: WalletTxnReason.VIP_PURCHASE,
              // Bound to the recipient's pre-gift expiry: stable across retries,
              // unique once the gifted membership is applied.
              idempotencyKey: `vip:gift:${gifterUserId}:${recipientUserId}:${level}:${existingRecipient?.expiresAt?.toISOString() ?? 'new'}`,
              metadata: { level, recipientUserId },
            },
            tx,
          );
        }

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
      await this.eventService.publishVipEvent(VIP_EVENTS.CREATED, {
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
