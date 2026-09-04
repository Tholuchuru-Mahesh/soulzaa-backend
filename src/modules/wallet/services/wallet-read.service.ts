import { Injectable } from '@nestjs/common';
import { GiftContextType, GiftTxnStatus, LedgerEntry, WalletCurrency, WalletTxnReason } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { HostEarningsDto, RewardDto } from '../dto/wallet.dto';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletService } from './wallet.service';

const REWARD_REASONS: WalletTxnReason[] = [
  WalletTxnReason.TREASURE_BOX,
  WalletTxnReason.PK_REWARD,
  WalletTxnReason.EVENT_REWARD,
];

/**
 * Read models over the wallet ledger (VR-14). No balance mutation; every method
 * is a query. Earnings/rewards/history are all `wallet_transactions` filtered by
 * reason/currency — the ledger is the single source of truth.
 */
@Injectable()
export class WalletReadService {
  constructor(
    private readonly repo: WalletRepository,
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  async getEarnings(userId: string, roomType?: GiftContextType): Promise<HostEarningsDto> {
    const effectiveRoomType = roomType ?? GiftContextType.AUDIO_ROOM;
    const [giftAgg, goldSums, entrySums, balances] = await Promise.all([
      this.prisma.giftTransaction.aggregate({
        where: {
          receiverId: userId,
          status: GiftTxnStatus.COMPLETED,
          contextType: effectiveRoomType,
        },
        _sum: { creatorEarnings: true },
      }),
      this.repo.sumByReason(
        userId,
        [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD],
        WalletCurrency.GOLD,
      ),
      effectiveRoomType === GiftContextType.VIDEO_ROOM
        ? this.repo.sumByReason(
            userId,
            ['VIDEO_ROOM_ENTRY_EARNING' as WalletTxnReason],
            WalletCurrency.DIAMOND,
          )
        : Promise.resolve([]),
      this.wallet.getBalance(userId),
    ]);
    const gifts = Number(giftAgg._sum.creatorEarnings ?? 0n);
    const sumOf = (
      rows: Array<{ reason: WalletTxnReason; total: bigint }>,
      reason: WalletTxnReason,
    ): number => Number(rows.find((s) => s.reason === reason)?.total ?? 0n);
    const treasure = sumOf(goldSums, WalletTxnReason.TREASURE_BOX);
    const pk = sumOf(goldSums, WalletTxnReason.PK_REWARD);
    const entryFee = Number(entrySums[0]?.total ?? 0n);

    return {
      // totalEarned is the authoritative lifetime earnings total (matches Creator Earnings Lifetime).
      totalEarned: gifts + treasure + pk + entryFee,
      // Only the DIAMOND wallet (gift diamonds / earnings) is withdrawable / settlement-ready.
      settlementReady: balances.diamond,
      bySource: { gifts, treasure, pk, entryFee },
    };
  }

  async getRewards(userId: string, page: number, limit: number): Promise<Paginated<RewardDto>> {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listByReasons(userId, REWARD_REASONS, skip, limit);
    return buildPaginated(
      rows.map((r) => this.toReward(r)),
      total,
      page,
      limit,
    );
  }

  async getHistory(
    userId: string,
    filters: { currency?: WalletCurrency; reason?: WalletTxnReason },
    page: number,
    limit: number,
  ): Promise<Paginated<RewardDto>> {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.repo.listHistory(userId, filters, skip, limit);
    return buildPaginated(
      rows.map((r) => this.toReward(r)),
      total,
      page,
      limit,
    );
  }

  private toReward(r: LedgerEntry): RewardDto {
    return {
      id: r.id,
      reason: r.reason,
      currency: r.currency,
      amount: Number(r.amount),
      source: r.referenceType,
      referenceId: r.referenceId,
      createdAt: r.createdAt,
    };
  }
}
