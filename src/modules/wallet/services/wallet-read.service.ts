// src/modules/wallet/services/wallet-read.service.ts
import { Injectable } from '@nestjs/common';
import { LedgerEntry, WalletCurrency, WalletTxnReason } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
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
  ) {}

  async getEarnings(userId: string): Promise<HostEarningsDto> {
    const [giftSums, goldSums, balances] = await Promise.all([
      this.repo.sumByReason(userId, [WalletTxnReason.GIFT_RECEIVE], WalletCurrency.EARNINGS),
      this.repo.sumByReason(
        userId,
        [WalletTxnReason.TREASURE_BOX, WalletTxnReason.PK_REWARD],
        WalletCurrency.GOLD,
      ),
      this.wallet.getBalance(userId),
    ]);
    const sumOf = (
      rows: Array<{ reason: WalletTxnReason; total: bigint }>,
      reason: WalletTxnReason,
    ): number => Number(rows.find((s) => s.reason === reason)?.total ?? 0n);
    const gifts = sumOf(giftSums, WalletTxnReason.GIFT_RECEIVE);
    const treasure = sumOf(goldSums, WalletTxnReason.TREASURE_BOX);
    const pk = sumOf(goldSums, WalletTxnReason.PK_REWARD);
    return {
      // totalEarned is a gross lifetime income tally across sources (nominal coins).
      totalEarned: gifts + treasure + pk,
      // Only the EARNINGS wallet (gift diamonds) is withdrawable / settlement-ready.
      settlementReady: balances.earnings,
      bySource: { gifts, treasure, pk },
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
