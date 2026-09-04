import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

/**
 * The ledgers a Super Admin can page through on an agency / coin seller
 * profile. Each maps to exactly one table; adding a value here without a
 * branch in {@link AgencyProfileService.getActivity} is a compile error rather
 * than a silently empty page.
 */
export const AGENCY_ACTIVITY_TYPES = [
  'coin-sales',
  'inventory-purchases',
  'wallet-ledger',
  'settlements',
  'rewards',
] as const;

export type AgencyActivityType = (typeof AGENCY_ACTIVITY_TYPES)[number];

/** Identity fields hydrated onto a counterparty row (buyer, host, recipient). */
export interface Counterparty {
  id: string;
  username: string;
  fullName: string | null;
  country: string | null;
  status: string;
  avatarUrl: string | null;
}

/** Coin quantities are BigInt in the schema; JSON gets strings, never floats. */
function coins(value: bigint | null | undefined): string {
  return (value ?? BigInt(0)).toString();
}

/**
 * Read model behind the Super Admin agency drill-down.
 *
 * An agency account carries three unrelated coin figures and the panel has to
 * keep them apart: resale stock bought from the platform
 * (`CoinSellerInventory`), the account's own spendable wallet (`Wallet`), and
 * commission income earned off its hosts (`AgencySettlement`). Aggregating any
 * two of them would be wrong, so each is surfaced under its own key.
 *
 * Every side table is optional. An approved agency that never paid the coin
 * seller fee has no inventory row, and an account that never transacted has no
 * wallet row — both are ordinary states that must render as zero rather than
 * blank out the screen, so only the user row itself is required.
 */
@Injectable()
export class AgencyProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

  async getOverview(agencyId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: agencyId },
      select: {
        id: true,
        displayId: true,
        username: true,
        fullName: true,
        email: true,
        mobile: true,
        country: true,
        status: true,
        roles: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`Agency ${agencyId} not found`);
    }

    const [profile, activation, inventory, wallet, settlementTotals, periods, relationships] =
      await Promise.all([
        this.prisma.userProfile.findUnique({
          where: { userId: agencyId },
          select: { avatarKey: true, bio: true, city: true, state: true },
        }),
        this.prisma.agencyActivation.findUnique({ where: { agencyId } }),
        this.prisma.coinSellerInventory.findUnique({ where: { sellerId: agencyId } }),
        this.prisma.wallet.findUnique({ where: { userId: agencyId } }),
        this.prisma.agencySettlement.aggregate({
          where: { agencyId },
          _sum: { agencyCommissionCoins: true, hostEarningsCoins: true },
          _count: { _all: true },
        }),
        this.prisma.agencyStatistics.findMany({
          where: { agencyId },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        }),
        this.prisma.agencyRelationship.findMany({
          where: { agencyId, status: 'ACTIVE' },
          select: { hostId: true },
        }),
      ]);

    const memberCounts = await this.countMembers(relationships.map((r) => r.hostId));

    return {
      profile: {
        id: user.id,
        displayId: user.displayId,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        mobile: user.mobile,
        country: user.country,
        status: user.status,
        roles: user.roles,
        bio: profile?.bio ?? null,
        city: profile?.city ?? null,
        state: profile?.state ?? null,
        avatarUrl: await this.media.resolve(profile?.avatarKey),
        createdAt: user.createdAt,
        // An agency that never opened the coin seller module has no activation
        // row at all, which is distinct from one that started and failed.
        activationStatus: activation?.status ?? 'NOT_REQUESTED',
        coinSellerActivatedAt: activation?.paidAt ?? null,
        activationFeeMinor: activation?.amountMinor ?? null,
        activationCurrency: activation?.currency ?? null,
      },
      coinSellerInventory: {
        exists: inventory !== null,
        country: inventory?.country ?? user.country ?? null,
        purchasedTotal: coins(inventory?.purchasedTotal),
        availableBalance: coins(inventory?.availableBalance),
        reservedBalance: coins(inventory?.reservedBalance),
        soldTotal: coins(inventory?.soldTotal),
        updatedAt: inventory?.updatedAt ?? null,
      },
      wallet: {
        exists: wallet !== null,
        goldBalance: coins(wallet?.goldBalance),
        diamondBalance: coins(wallet?.diamondBalance),
        gameBalance: coins(wallet?.gameBalance),
        lockedBalance: coins(wallet?.lockedBalance),
        availableBalance: coins(wallet?.availableBalance),
        totalRecharged: coins(wallet?.totalRecharged),
        totalSpent: coins(wallet?.totalSpent),
        status: wallet?.status ?? null,
        type: wallet?.type ?? null,
      },
      settlement: {
        // Gross host earnings and the agency's cut of them are different
        // figures; the panel shows both rather than implying one is the other.
        lifetimeHostEarningsCoins: coins(settlementTotals._sum.hostEarningsCoins),
        lifetimeCommissionCoins: coins(settlementTotals._sum.agencyCommissionCoins),
        settlementCount: settlementTotals._count._all,
        periods: periods.map((p) => ({
          period: p.period,
          dateKey: p.dateKey,
          totalCommissionCoins: coins(p.totalCommissionCoins),
          settlementCount: p.settlementCount,
          updatedAt: p.updatedAt,
        })),
      },
      memberCounts,
    };
  }

  async getActivity(agencyId: string, type: AgencyActivityType, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const envelope = <T>(items: T[], total: number) => ({ items, total, page, limit });

    switch (type) {
      case 'coin-sales': {
        const [rows, total] = await Promise.all([
          this.prisma.coinSellerUserSaleTransaction.findMany({
            where: { sellerId: agencyId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          this.prisma.coinSellerUserSaleTransaction.count({ where: { sellerId: agencyId } }),
        ]);

        const buyers = await this.hydrateCounterparties(rows.map((r) => r.buyerId));

        return envelope(
          rows.map((r) => ({
            id: r.id,
            coinAmount: coins(r.coinAmount),
            status: r.status,
            sellerCountry: r.sellerCountry,
            buyerCountry: r.buyerCountry,
            buyerWalletTxnId: r.buyerWalletTxnId ?? null,
            paymentProofRef: r.paymentProofRef ?? null,
            createdAt: r.createdAt,
            buyer: buyers.get(r.buyerId) ?? null,
          })),
          total,
        );
      }

      case 'inventory-purchases': {
        const [rows, total] = await Promise.all([
          this.prisma.coinSellerInventoryPurchaseOrder.findMany({
            where: { sellerId: agencyId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          this.prisma.coinSellerInventoryPurchaseOrder.count({ where: { sellerId: agencyId } }),
        ]);

        return envelope(
          rows.map((r) => ({
            id: r.id,
            packageCode: r.packageCode,
            coinAmount: coins(r.coinAmount),
            priceAmount: r.priceAmount?.toString() ?? null,
            priceCurrency: r.priceCurrency,
            status: r.status,
            paymentProvider: r.paymentProvider ?? null,
            providerTxnRef: r.providerTxnRef ?? null,
            approvedAt: r.approvedAt ?? null,
            creditedAt: r.creditedAt ?? null,
            createdAt: r.createdAt,
          })),
          total,
        );
      }

      case 'wallet-ledger': {
        const wallet = await this.prisma.wallet.findUnique({
          where: { userId: agencyId },
          select: { id: true },
        });

        // Ledger entries key off walletId, so with no wallet there is nothing
        // to query — return the empty page rather than scanning every entry.
        if (!wallet) return envelope([], 0);

        const [rows, total] = await Promise.all([
          this.prisma.ledgerEntry.findMany({
            where: { walletId: wallet.id },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          this.prisma.ledgerEntry.count({ where: { walletId: wallet.id } }),
        ]);

        return envelope(
          rows.map((r) => ({
            id: r.id,
            type: r.type,
            currency: r.currency,
            reason: r.reason,
            amount: coins(r.amount),
            balanceBefore: coins(r.balanceBefore),
            balanceAfter: coins(r.balanceAfter),
            description: r.description ?? null,
            referenceType: r.referenceType ?? null,
            referenceId: r.referenceId ?? null,
            createdAt: r.createdAt,
          })),
          total,
        );
      }

      case 'settlements': {
        const [rows, total] = await Promise.all([
          this.prisma.agencySettlement.findMany({
            where: { agencyId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          this.prisma.agencySettlement.count({ where: { agencyId } }),
        ]);

        const hosts = await this.hydrateCounterparties(rows.map((r) => r.hostId));

        return envelope(
          rows.map((r) => ({
            id: r.id,
            hostEarningsCoins: coins(r.hostEarningsCoins),
            commissionPercentage: r.commissionPercentage,
            agencyCommissionCoins: coins(r.agencyCommissionCoins),
            status: r.status,
            createdAt: r.createdAt,
            host: hosts.get(r.hostId) ?? null,
          })),
          total,
        );
      }

      case 'rewards': {
        const [rows, total] = await Promise.all([
          this.prisma.agencyRewardDistribution.findMany({
            where: { agencyId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
          }),
          this.prisma.agencyRewardDistribution.count({ where: { agencyId } }),
        ]);

        const recipients = await this.hydrateCounterparties(rows.map((r) => r.recipientId));

        return envelope(
          rows.map((r) => ({
            id: r.id,
            itemType: r.itemType,
            refId: r.refId ?? null,
            name: r.name,
            quantity: r.quantity,
            kind: r.kind,
            note: r.note ?? null,
            createdAt: r.createdAt,
            recipient: recipients.get(r.recipientId) ?? null,
          })),
          total,
        );
      }

      default:
        throw new BadRequestException(
          `Unknown activity type. Expected one of: ${AGENCY_ACTIVITY_TYPES.join(', ')}`,
        );
    }
  }

  /**
   * Resolves the ids on one page of rows to display identities in two queries,
   * rather than one pair per row. A deleted account simply stays absent from
   * the map, leaving its row's counterparty null.
   */
  private async hydrateCounterparties(ids: string[]): Promise<Map<string, Counterparty>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const [users, profiles] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: unique } },
        select: {
          id: true,
          username: true,
          fullName: true,
          country: true,
          status: true,
        },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: unique } },
        select: { userId: true, avatarKey: true },
      }),
    ]);

    const avatarKeys = new Map(profiles.map((p) => [p.userId, p.avatarKey]));
    const resolved = await Promise.all(
      users.map(async (u) => ({
        ...u,
        avatarUrl: await this.media.resolve(avatarKeys.get(u.id)),
      })),
    );

    return new Map(resolved.map((u) => [u.id, u as Counterparty]));
  }

  private async countMembers(hostIds: string[]) {
    if (hostIds.length === 0) return { total: 0, creators: 0, users: 0 };

    const members = await this.prisma.user.findMany({
      where: { id: { in: hostIds } },
      select: { id: true, roles: true },
    });

    const creators = members.filter((m) => m.roles.includes('CREATOR' as never)).length;

    return { total: members.length, creators, users: members.length - creators };
  }
}
