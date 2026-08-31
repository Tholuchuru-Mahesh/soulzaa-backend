import { Inject, Injectable } from '@nestjs/common';
import {
  BackpackItemSource,
  BackpackItemType,
  TreasureRewardKind,
  WalletCurrency,
  WalletTxnReason,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  BACKPACK_SERVICE,
  type IBackpackService,
} from 'src/modules/backpack/interfaces/backpack.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import type { RewardEntry } from '../constants/treasure.constants';

/** A contributor eligible for a ranked reward. */
export interface RankedRecipient {
  rank: number;
  userId: string;
}

/** A reward that was actually distributed (for the immutable ledger + broadcast). */
export interface DistributedReward {
  userId: string;
  rank: number;
  kind: TreasureRewardKind;
  coins: bigint | null;
  itemType: string | null;
  itemName: string | null;
  itemRefId: string | null;
  /** Servable media URLs for the granted cosmetic (resolved), for the broadcast. */
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  /** When the granted cosmetic expires and is removed, or null for permanent. */
  expiresAt: Date | null;
  walletTxnId: string | null;
  backpackItemId: string | null;
}

/** Cosmetic types whose ownership is also tracked in `user_cosmetics` for equip. */
const USER_COSMETIC_TYPES: ReadonlySet<string> = new Set(['FRAME', 'THEME', 'ENTRANCE_EFFECT']);

/**
 * Distributes a reward list to ranked recipients: COINS credit the wallet
 * (idempotent), BACKPACK_ITEM grants a catalog cosmetic into the backpack
 * (idempotent on `grantKey`) and mirrors ownership into `user_cosmetics` for the
 * equippable types — the exact rows the existing backpack/cosmetics equip +
 * ownership flow reads. The `idempotencyPrefix` (a box-open / rocket-completion
 * id) makes the whole distribution safe to re-run: a replay maps to the same
 * wallet/backpack rows. Shared by treasure boxes and rocket events. Every write
 * takes the caller's `tx` when one is supplied so distribution stays inside the
 * gift-send transaction.
 */
@Injectable()
export class RewardDistributor {
  constructor(
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

  async distribute(
    input: {
      recipients: RankedRecipient[];
      rewards: RewardEntry[];
      idempotencyPrefix: string;
      walletReason: WalletTxnReason;
      backpackSource: BackpackItemSource;
      referenceType: string;
      referenceId: string;
    },
    tx?: any,
  ): Promise<DistributedReward[]> {
    const byRank = new Map(input.recipients.map((r) => [r.rank, r.userId]));
    const client = tx ?? this.prisma;
    const distributed: DistributedReward[] = [];

    // A rank may carry more than one reward entry; the index disambiguates the
    // per-entry idempotency key so two rewards at the same rank don't collide.
    for (let i = 0; i < input.rewards.length; i++) {
      const reward = input.rewards[i];
      const userId = byRank.get(reward.rank);
      if (!userId) continue; // no contributor at this rank → reward unclaimed
      const slot = `r${reward.rank}#${i}`;

      // A cosmetic reward must name a catalog asset. Legacy configs seeded with
      // free-text placeholder names (no `itemRefId`) are inert — the reward is
      // configured from the Super Admin panel by picking a real asset or it does
      // not pay out at all.
      if (reward.kind === 'BACKPACK_ITEM' && !reward.itemRefId) continue;

      if (reward.kind === 'COINS' && reward.coins && reward.coins > 0) {
        const res = await this.wallet.credit(
          {
            userId,
            currency: WalletCurrency.GOLD,
            amount: reward.coins,
            reason: input.walletReason,
            idempotencyKey: `${input.idempotencyPrefix}:${slot}:coins`,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
          },
          tx,
        );
        distributed.push({
          userId,
          rank: reward.rank,
          kind: TreasureRewardKind.COINS,
          coins: BigInt(reward.coins),
          itemType: null,
          itemName: null,
          itemRefId: null,
          mediaUrl: null,
          thumbnailUrl: null,
          expiresAt: null,
          walletTxnId: res.transactionId,
          backpackItemId: null,
        });
      } else if (reward.kind === 'BACKPACK_ITEM' && reward.itemType && reward.itemName) {
        const metadata: Record<string, any> = {
          referenceType: input.referenceType,
          referenceId: input.referenceId,
        };
        let rawMediaUrl: string | null = null;
        let rawThumbnailUrl: string | null = null;
        let transferable = reward.transferable ?? false;
        let expiresAt: Date | undefined = this.ttlToExpiry(reward.ttlDays);

        if (reward.itemRefId) {
          const cosmetic = await client.cosmetic
            .findUnique({ where: { id: reward.itemRefId } })
            .catch(() => null);
          if (cosmetic) {
            rawMediaUrl = cosmetic.mediaUrl ?? null;
            rawThumbnailUrl = cosmetic.thumbnailUrl ?? null;
            metadata.cosmeticId = cosmetic.id;
            metadata.rarity = cosmetic.rarity;
            metadata.mediaUrl = cosmetic.mediaUrl;
            metadata.thumbnailUrl = cosmetic.thumbnailUrl;
            if (reward.transferable === undefined) transferable = cosmetic.transferable ?? false;

            // The admin-set TTL wins. Only fall back to the cosmetic's own
            // duration when the reward has no explicit TTL configured at all.
            if (reward.ttlDays === undefined) {
              const cosMeta = (cosmetic.metadata as Record<string, any>) || {};
              const durationDays = Number(cosMeta.durationDays ?? cosMeta.ttlDays);
              if (Number.isFinite(durationDays) && durationDays > 0) {
                expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
              }
            }

            // Mirror ownership into user_cosmetics for the equippable types — the
            // same row CosmeticsService.equip / ownership checks read. Passing the
            // TTL here makes the cosmetic disappear from the equip picker too.
            if (USER_COSMETIC_TYPES.has(cosmetic.type)) {
              await client.userCosmetic.upsert({
                where: { userId_cosmeticId: { userId, cosmeticId: cosmetic.id } },
                create: { userId, cosmeticId: cosmetic.id, equipped: false, expiresAt },
                update: expiresAt ? { expiresAt } : {},
              });
            }
          }
        }

        const res = await this.backpack.grant(
          {
            userId,
            type: reward.itemType as BackpackItemType,
            name: reward.itemName,
            source: input.backpackSource,
            refId: reward.itemRefId,
            transferable,
            grantKey: `${input.idempotencyPrefix}:${slot}:item`,
            metadata,
            ...(expiresAt ? { expiresAt } : {}),
          },
          tx,
        );
        distributed.push({
          userId,
          rank: reward.rank,
          kind: TreasureRewardKind.BACKPACK_ITEM,
          coins: null,
          itemType: reward.itemType,
          itemName: reward.itemName,
          itemRefId: reward.itemRefId ?? null,
          mediaUrl: await this.media.resolve(rawMediaUrl),
          thumbnailUrl: await this.media.resolve(rawThumbnailUrl ?? rawMediaUrl),
          expiresAt: expiresAt ?? null,
          walletTxnId: null,
          backpackItemId: res.itemId,
        });
      }
    }
    return distributed;
  }

  /**
   * Admin-configured reward TTL → an absolute expiry, or undefined for a
   * permanent reward. `ttlDays` of 0 (or undefined) means permanent.
   */
  private ttlToExpiry(ttlDays: number | undefined): Date | undefined {
    if (ttlDays === undefined) return undefined;
    const days = Number(ttlDays);
    if (!Number.isFinite(days) || days <= 0) return undefined;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
