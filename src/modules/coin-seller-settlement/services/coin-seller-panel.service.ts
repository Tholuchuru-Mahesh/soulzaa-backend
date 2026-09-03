import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { resolveUserCountryCode } from '../utils/resolve-user-country';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinSellerInventoryService } from './coin-seller-inventory.service';

/**
 * Read side of the agency coin panel — what the Coins inventory, Buy coins and
 * Coins history screens render.
 *
 * Everything here is derived from the ledger rather than stored as a running
 * figure, so a number on screen can never disagree with the transactions
 * behind it.
 */
@Injectable()
export class CoinSellerPanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: CoinSellerInventoryService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /** The wholesale tiers, in the order the panel shows them. */
  async listPackages() {
    const packages = await this.prisma.coinSellerInventoryPackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
    });

    return packages.map((pkg) => ({
      id: pkg.id,
      code: pkg.code,
      name: pkg.name,
      coinAmount: pkg.coinAmount.toString(),
      priceAmount: Number(pkg.priceAmount),
      priceCurrency: pkg.priceCurrency,
    }));
  }

  /**
   * The inventory screen: balances, the day's and month's sales, and the
   * detail block.
   */
  async getInventorySummary(sellerId: string) {
    const inventory = await this.inventory.getOrInitInventory(sellerId);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

    // Summed from the sale ledger rather than kept as counters: a counter can
    // drift from the transactions it claims to summarise, and this figure is
    // shown next to the balance it must agree with.
    const [soldToday, soldThisMonth, lastCredited] = await Promise.all([
      this.prisma.coinSellerUserSaleTransaction.aggregate({
        _sum: { coinAmount: true },
        where: { sellerId, status: 'COMPLETED', createdAt: { gte: startOfToday } },
      }),
      this.prisma.coinSellerUserSaleTransaction.aggregate({
        _sum: { coinAmount: true },
        where: { sellerId, status: 'COMPLETED', createdAt: { gte: startOfMonth } },
      }),
      this.prisma.coinSellerInventoryPurchaseOrder.findFirst({
        where: { sellerId, status: 'INVENTORY_CREDITED' },
        orderBy: { creditedAt: 'desc' },
        select: { creditedAt: true, approvedBy: true },
      }),
    ]);

    // The panel shows a name, not an id. Resolved here rather than sent raw:
    // a uuid on screen tells the agency nothing about who restocked them.
    // Null for a self-serve Razorpay purchase — nobody approved it, the agency
    // simply bought it — which the app renders as a dash.
    const approver = lastCredited?.approvedBy
      ? await this.prisma.user.findUnique({
          where: { id: lastCredited.approvedBy },
          select: { username: true, fullName: true },
        })
      : null;

    return {
      inventoryId: inventory.id,
      country: inventory.country,
      availableBalance: inventory.availableBalance.toString(),
      purchasedTotal: inventory.purchasedTotal.toString(),
      reservedBalance: inventory.reservedBalance.toString(),
      soldTotal: inventory.soldTotal.toString(),
      soldToday: (soldToday._sum.coinAmount ?? BigInt(0)).toString(),
      soldThisMonth: (soldThisMonth._sum.coinAmount ?? BigInt(0)).toString(),
      lastRestockedAt: lastCredited?.creditedAt ?? null,
      addedByOfficial: approver?.username ?? approver?.fullName ?? null,
    };
  }

  /**
   * The coins history screen. `type` filters the two chips; omitting it is the
   * "All" chip.
   */
  async listHistory(
    sellerId: string,
    options: { type?: 'SENT' | 'ADDED'; limit?: number; cursor?: string } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

    const sales =
      options.type === 'ADDED'
        ? []
        : await this.prisma.coinSellerUserSaleTransaction.findMany({
            where: { sellerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });

    const purchases =
      options.type === 'SENT'
        ? []
        : await this.prisma.coinSellerInventoryPurchaseOrder.findMany({
            where: { sellerId, status: 'INVENTORY_CREDITED' },
            orderBy: { creditedAt: 'desc' },
            take: limit,
          });

    const entries = [
      ...sales.map((sale) => ({
        id: sale.id,
        type: 'SENT' as const,
        counterpartyId: sale.buyerId,
        coinAmount: sale.coinAmount.toString(),
        status: sale.status,
        occurredAt: sale.createdAt,
      })),
      ...purchases.map((order) => ({
        id: order.id,
        type: 'ADDED' as const,
        counterpartyId: order.approvedBy,
        coinAmount: order.coinAmount.toString(),
        status: order.status,
        occurredAt: order.creditedAt ?? order.updatedAt,
      })),
    ];

    // The two sources are each sorted, but interleaving them is not — so sort
    // the merged list before trimming, or the newest entries of one kind would
    // be dropped in favour of older entries of the other.
    entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const page = entries.slice(0, limit);

    // Names are resolved after the trim, in one query for the whole page: the
    // list shows a customer name per row, and a uuid is not one. Doing it per
    // row would be a query per row.
    const counterpartyIds = [
      ...new Set(page.map((entry) => entry.counterpartyId).filter((id): id is string => !!id)),
    ];
    const users = counterpartyIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: counterpartyIds } },
          select: { id: true, username: true, fullName: true },
        })
      : [];
    const nameById = new Map(users.map((user) => [user.id, user.username ?? user.fullName]));

    return {
      entries: page.map((entry) => ({
        ...entry,
        // Null when the row has no counterparty to name — a coin purchase the
        // agency made itself through Razorpay has no approving official. The
        // app renders that as a dash rather than inventing a name.
        counterpartyName: entry.counterpartyId
          ? (nameById.get(entry.counterpartyId) ?? null)
          : null,
      })),
    };
  }

  /**
   * Finds a buyer to sell coins to, by the id or username the seller was given.
   *
   * Restricted to the seller's own country (PRD §20): coin sales are
   * country-bound, so a buyer elsewhere is reported as not found rather than
   * shown and then refused at the point of sale. That is also why this returns
   * nothing rather than "wrong country" — the seller has no business learning
   * which country a stranger is in.
   *
   * Accepts a full uuid, the leading block the app displays, or a username.
   */
  async lookupBuyer(sellerId: string, query: string) {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Enter at least 3 characters of the user id or username',
      );
    }

    const sellerCountry = await resolveUserCountryCode(this.prisma, sellerId);
    if (!sellerCountry) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Set your own country before selling coins',
      );
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
    const isNumeric = /^\d+$/.test(trimmed);

    // A uuid column cannot be LIKE-matched directly — Postgres rejects it — so
    // the prefix search casts to text in raw SQL. The app shows users the
    // leading block of their uuid (8-character hex ID) as their id, so that prefix is exactly what a
    // seller is given to type.
    const prefixMatches = isUuid
      ? []
      : await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM users
          WHERE (id::text LIKE ${`${trimmed.toLowerCase()}%`}
             OR username ILIKE ${`${trimmed}%`}
             OR email ILIKE ${`${trimmed}%`})
            AND id <> ${sellerId}::uuid
          LIMIT 10`;

    const candidates = await this.prisma.user.findMany({
      where: {
        AND: [
          { id: { not: sellerId } },
          isUuid
            ? { id: trimmed }
            : isNumeric
            ? {
                OR: [
                  { displayId: parseInt(trimmed, 10) },
                  { username: { equals: trimmed, mode: 'insensitive' as const } },
                  { id: { in: prefixMatches.map((row) => row.id) } },
                ],
              }
            : {
                OR: [
                  { username: { equals: trimmed, mode: 'insensitive' as const } },
                  { email: { equals: trimmed, mode: 'insensitive' as const } },
                  { id: { in: prefixMatches.map((row) => row.id) } },
                ],
              },
        ],
      },
      select: { id: true, username: true, fullName: true, country: true, countryId: true, displayId: true },
      take: 10,
    });

    const sameCountry = [];
    for (const candidate of candidates) {
      const country = await resolveUserCountryCode(this.prisma, candidate.id);
      if (!country || country === sellerCountry || candidate.country === sellerCountry) {
        sameCountry.push({ ...candidate, country: country ?? sellerCountry });
      }
    }

    if (sameCountry.length === 0) {
      throw new NotFoundException('No user in your country matches that id');
    }

    // Pick best match: exact UUID prefix match, exact displayId, exact username, or first candidate
    const exact =
      sameCountry.find(
        (c) =>
          c.id.toLowerCase().startsWith(trimmed.toLowerCase()) ||
          c.username.toLowerCase() === trimmed.toLowerCase() ||
          (isNumeric && c.displayId === parseInt(trimmed, 10)),
      ) ?? sameCountry[0];

    const identity = (await this.profiles.resolvePublicIdentities([exact.id])).get(exact.id);

    return {
      userId: exact.id,
      username: exact.username,
      displayName: identity?.displayName ?? exact.fullName ?? exact.username,
      avatarUrl: identity?.avatarUrl ?? null,
      country: exact.country,
    };
  }

  /**
   * One order's payment state, for the app to poll after the buyer comes back
   * from Razorpay's hosted page.
   *
   * The app cannot learn the outcome from the browser: the coins are credited
   * by the webhook, which arrives server-to-server and may land before or after
   * the buyer returns. So the app asks here instead of inferring anything from
   * the redirect.
   *
   * Scoped to the caller's own orders — an order id is a uuid, but guessing one
   * should still not reveal another seller's purchase.
   */
  async getPurchaseOrderStatus(sellerId: string, orderId: string) {
    const order = await this.prisma.coinSellerInventoryPurchaseOrder.findFirst({
      where: { id: orderId, sellerId },
    });

    if (!order) {
      throw new NotFoundException('Purchase order not found');
    }

    return {
      purchaseOrderId: order.id,
      status: order.status,
      // The one field the success screen needs: coins are only in the balance
      // once this is true, so the app polls until it flips rather than
      // assuming payment implies credit.
      credited: order.status === 'INVENTORY_CREDITED',
      coinAmount: order.coinAmount.toString(),
      priceAmount: Number(order.priceAmount),
      priceCurrency: order.priceCurrency,
      creditedAt: order.creditedAt,
    };
  }
}
