import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BackpackItemSource,
  Cosmetic,
  CosmeticPurchase,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CosmeticPurchasedEvent } from '../events/cosmetics.events';
import type { CosmeticType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CosmeticsRepository } from '../repositories/cosmetics.repository';
import { CosmeticsService } from './cosmetics.service';

/**
 * The premium cosmetics store (AR-9): buy a premium cosmetic (background,
 * animated theme, decoration, badge, effect) with gold coins. Debits the wallet,
 * grants the cosmetic into the backpack (via the cosmetics grant seam), and
 * records an immutable purchase — all idempotent on the purchase key, with a
 * compensating refund if the grant/ledger write fails.
 */
const DEFAULT_ANIMATED_FRAMES = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Default Pink Charm',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'default_pink_frame',
    thumbnailUrl: 'default_pink_frame',
    rarity: 'COMMON' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 1,
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    name: 'Neon Cyber Glow',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'neon_cyber_glow',
    thumbnailUrl: 'neon_cyber_glow',
    rarity: 'EPIC' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 2,
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    name: 'Royal Gold & Fire Aura',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'royal_gold_fire',
    thumbnailUrl: 'royal_gold_fire',
    rarity: 'LEGENDARY' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 3,
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    name: 'Cosmic Galaxy & Starburst',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'cosmic_galaxy_star',
    thumbnailUrl: 'cosmic_galaxy_star',
    rarity: 'MYTHIC' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 4,
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    name: 'Dragon Inferno Flame',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'dragon_inferno_flame',
    thumbnailUrl: 'dragon_inferno_flame',
    rarity: 'LEGENDARY' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 5,
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    name: 'Sakura Mystic Blossom',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'sakura_mystic_blossom',
    thumbnailUrl: 'sakura_mystic_blossom',
    rarity: 'RARE' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 6,
  },
  {
    id: '00000000-0000-0000-0000-000000000007',
    name: 'Emerald Lightning Surge',
    type: 'FRAME' as CosmeticType,
    mediaUrl: 'emerald_lightning',
    thumbnailUrl: 'emerald_lightning',
    rarity: 'EPIC' as any,
    price: 0,
    isPremium: false,
    enabled: true,
    sortOrder: 7,
  },
];

@Injectable()
export class CosmeticsStoreService {
  private readonly logger = new Logger(CosmeticsStoreService.name);

  constructor(
    private readonly repo: CosmeticsRepository,
    private readonly cosmetics: CosmeticsService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly queue: QueueService,
    private readonly media: MediaUrlResolver,
    private readonly prisma: PrismaService,
  ) {}

  async listStore(type?: CosmeticType): Promise<
    (Omit<Cosmetic, 'mediaUrl' | 'thumbnailUrl'> & {
      mediaUrl: string | null;
      thumbnailUrl: string | null;
    })[]
  > {
    if (!type || type === 'FRAME') {
      for (const frame of DEFAULT_ANIMATED_FRAMES) {
        await this.prisma.cosmetic.upsert({
          where: { id: frame.id },
          create: frame,
          update: {
            name: frame.name,
            mediaUrl: frame.mediaUrl,
            thumbnailUrl: frame.thumbnailUrl,
            price: frame.price,
            enabled: frame.enabled,
            sortOrder: frame.sortOrder,
            rarity: frame.rarity,
          },
        }).catch(() => null);
      }
    }

    const rows = await this.repo.listStore(type);
    return Promise.all(
      rows.map(async (c) => ({
        ...c,
        mediaUrl: await this.media.resolve(c.mediaUrl),
        thumbnailUrl: await this.media.resolve(c.thumbnailUrl),
      })),
    );
  }

  async purchases(
    userId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listPurchases(userId, q.skip, q.limit);
    return buildPaginated(
      rows.map((p) => this.toView(p)),
      total,
      q.page,
      q.limit,
    );
  }

  async purchase(
    userId: string,
    cosmeticId: string,
    idempotencyKey?: string,
  ): Promise<{ purchaseId: string; backpackItemId: string; duplicate: boolean }> {
    const cosmetic = await this.repo.getById(cosmeticId);
    if (!cosmetic || !cosmetic.enabled || !cosmetic.isPremium || cosmetic.price <= 0) {
      throw new BusinessException(
        ERROR_CODES.COSMETIC_NOT_PURCHASABLE,
        'This cosmetic is not available for purchase.',
        HttpStatus.CONFLICT,
      );
    }

    const key = idempotencyKey?.trim() || `cosmetic-buy:${randomUUID()}`;
    const prior = await this.repo.findPurchaseByKey(key);
    if (prior) {
      return { purchaseId: prior.id, backpackItemId: prior.backpackItemId ?? '', duplicate: true };
    }

    // 1) Debit gold (throws INSUFFICIENT_BALANCE), idempotent on the key.
    const debit = await this.wallet.debit({
      userId,
      currency: WalletCurrency.GOLD,
      amount: cosmetic.price,
      reason: WalletTxnReason.COSMETIC_PURCHASE,
      idempotencyKey: `cosmetic-debit:${key}`,
      referenceType: 'cosmetic',
      referenceId: cosmeticId,
      metadata: { cosmeticId, name: cosmetic.name },
    });

    // 2) Grant + 3) record. Compensate the debit on failure (all-or-nothing).
    try {
      const grant = await this.cosmetics.grantToUser({
        userId,
        cosmeticId,
        source: BackpackItemSource.PURCHASE,
        grantKey: `cosmetic-grant:${key}`,
      });
      const backpackItemId = grant?.backpackItemId ?? null;

      const purchase = await this.repo.createPurchase({
        userId,
        cosmeticId,
        price: BigInt(cosmetic.price),
        walletTxnId: debit.transactionId,
        backpackItemId,
        idempotencyKey: key,
      });

      await this.bus.publish(
        new CosmeticPurchasedEvent({
          userId,
          cosmeticId,
          type: cosmetic.type,
          name: cosmetic.name,
          price: cosmetic.price,
          backpackItemId: backpackItemId ?? '',
        }),
      );
      await this.queue.enqueue(QUEUE_NAMES.ANALYTICS_PROCESSING, 'cosmetic.purchased', {
        userId,
        cosmeticId,
        price: cosmetic.price,
      });
      return { purchaseId: purchase.id, backpackItemId: backpackItemId ?? '', duplicate: false };
    } catch (err) {
      await this.refund(userId, cosmetic.price, key);
      throw err;
    }
  }

  private async refund(userId: string, price: number, key: string): Promise<void> {
    try {
      await this.wallet.credit({
        userId,
        currency: WalletCurrency.GOLD,
        amount: price,
        reason: WalletTxnReason.ADMIN_CREDIT,
        idempotencyKey: `cosmetic-refund:${key}`,
        referenceType: 'cosmetic',
        metadata: { refund: true, reason: 'cosmetic_purchase_failed' },
      });
    } catch (err) {
      this.logger.error(`Cosmetic refund failed for key ${key}: ${(err as Error).message}`);
    }
  }

  private toView(p: CosmeticPurchase) {
    return {
      id: p.id,
      cosmeticId: p.cosmeticId,
      price: Number(p.price),
      backpackItemId: p.backpackItemId,
      createdAt: p.createdAt,
    };
  }
}
