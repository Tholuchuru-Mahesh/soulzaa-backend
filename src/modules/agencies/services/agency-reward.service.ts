import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';

const MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back each chip on the history screen looks. */
export type AgencyDistributionRange = 'all' | 'today' | 'week' | 'month';

/**
 * The agency's reward shelf, and sending from it.
 *
 * The recipient's copy is a `BackpackItem` rather than a parallel inventory:
 * the spec's Assigned reward is exactly a backpack item that cannot be passed
 * on, which the existing `transferable` flag already expresses. Reusing it
 * means one equip path, one expiry path and one audit trail instead of two.
 *
 * ASSIGNED  -> transferable = false (permanently bound to the recipient)
 * OWNED     -> transferable = true  (may be gifted on, subject to quantity)
 */
@Injectable()
export class AgencyRewardService {
  constructor(
    private readonly prisma: PrismaService,
    // The history rows render a recipient thumbnail, which a bare id cannot
    // fill. Identity comes from the profile seam for the same reason as
    // everywhere else: it honours the hidden-account rules.
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /** What the agency currently holds. */
  async listInventory(agencyId: string) {
    const rows = await this.prisma.agencyRewardInventory.findMany({
      where: { agencyId },
      orderBy: [{ itemType: 'asc' }, { name: 'asc' }],
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        itemType: row.itemType,
        refId: row.refId,
        name: row.name,
        quantity: row.quantity,
        allocatedTotal: row.allocatedTotal,
        distributedTotal: row.distributedTotal,
        expiresAt: row.expiresAt,
      })),
      // Summed from the rows on screen, so the header cannot disagree with the
      // list beneath it.
      totals: {
        available: rows.reduce((sum, row) => sum + row.quantity, 0),
        allocated: rows.reduce((sum, row) => sum + row.allocatedTotal, 0),
        distributed: rows.reduce((sum, row) => sum + row.distributedTotal, 0),
      },
    };
  }

  /** What the agency has sent, newest first. */
  async listDistributions(
    agencyId: string,
    options: { page?: number; limit?: number; range?: AgencyDistributionRange } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);
    const where = { agencyId, ...this.rangeFilter(options.range ?? 'all') };

    const [rows, total] = await Promise.all([
      this.prisma.agencyRewardDistribution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agencyRewardDistribution.count({ where }),
    ]);

    // One bulk call for the whole page, deduplicated: a member rewarded five
    // times is one lookup, not five.
    const identities = await this.profiles.resolvePublicIdentities([
      ...new Set(rows.map((r) => r.recipientId)),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        recipientId: row.recipientId,
        recipientName: identities.get(row.recipientId)?.displayName ?? null,
        recipientAvatarUrl: identities.get(row.recipientId)?.avatarUrl ?? null,
        itemType: row.itemType,
        name: row.name,
        quantity: row.quantity,
        kind: row.kind,
        note: row.note,
        occurredAt: row.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * The three figures above the distribution screen's member list.
   *
   * Its own method rather than a block on `listDistributions`: the screen that
   * needs these wants no rows at all, and the screen that wants rows needs no
   * stats.
   */
  async getStats(agencyId: string) {
    const [totalSent, today, thisMonth] = await Promise.all([
      this.prisma.agencyRewardDistribution.count({ where: { agencyId } }),
      this.prisma.agencyRewardDistribution.count({
        where: { agencyId, ...this.rangeFilter('today') },
      }),
      this.prisma.agencyRewardDistribution.count({
        where: { agencyId, ...this.rangeFilter('month') },
      }),
    ]);
    return { totalSent, today, thisMonth };
  }

  /**
   * `all` has no bound. `today` is the calendar day; the other two are rolling
   * windows, which is what "this week" means to someone looking at a list of
   * what they just sent.
   */
  private rangeFilter(range: AgencyDistributionRange) {
    if (range === 'all') return {};

    const now = new Date();
    if (range === 'today') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { createdAt: { gte: start } };
    }

    const days = range === 'week' ? 7 : 30;
    return { createdAt: { gte: new Date(now.getTime() - days * DAY_MS) } };
  }

  /**
   * Sends a reward from the agency's shelf to one of its members.
   *
   * Runs in one transaction that decrements the shelf, writes the distribution
   * and grants the backpack item together — a partial apply would either hand
   * out a reward the shelf still shows as available, or take stock without the
   * member receiving anything.
   */
  async distribute(
    agencyId: string,
    input: {
      inventoryId: string;
      recipientId: string;
      quantity: number;
      kind?: 'ASSIGNED' | 'OWNED';
      note?: string;
      idempotencyKey: string;
    },
  ) {
    const quantity = Math.floor(input.quantity);
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Quantity must be at least 1');
    }

    // Replay returns the original rather than sending twice.
    const existing = await this.prisma.agencyRewardDistribution.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      return existing;
    }

    // The recipient has to be one of this agency's own members. Without this
    // an agency could hand rewards to anyone on the platform.
    const membership = await this.prisma.agencyRelationship.findUnique({
      where: { agencyId_hostId: { agencyId, hostId: input.recipientId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new NotFoundException('This user is not a member of your agency');
    }

    const kind = input.kind ?? 'ASSIGNED';

    return this.prisma.$transaction(async (tx) => {
      // Locked before the balance is read: two concurrent sends would
      // otherwise both see enough stock and both decrement it.
      await tx.$queryRaw`SELECT id FROM agency_reward_inventories WHERE id = ${input.inventoryId}::uuid FOR UPDATE`;

      const shelf = await tx.agencyRewardInventory.findFirst({
        where: { id: input.inventoryId, agencyId },
      });
      if (!shelf) {
        throw new NotFoundException('Reward not found in your inventory');
      }
      if (shelf.quantity < quantity) {
        throw new BusinessException(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          `Only ${shelf.quantity} of ${shelf.name} left in your inventory`,
        );
      }
      if (shelf.expiresAt && shelf.expiresAt.getTime() < Date.now()) {
        throw new BusinessException(
          ERROR_CODES.VALIDATION_ERROR,
          `${shelf.name} has expired and can no longer be distributed`,
        );
      }

      await tx.agencyRewardInventory.update({
        where: { id: shelf.id },
        data: {
          quantity: { decrement: quantity },
          distributedTotal: { increment: quantity },
        },
      });

      const backpackItem = await tx.backpackItem.create({
        data: {
          userId: input.recipientId,
          type: shelf.itemType as never,
          refId: shelf.refId,
          name: shelf.name,
          source: 'AGENCY',
          quantity,
          // The whole difference between the spec's two reward models. An
          // Assigned reward is permanently linked to the recipient and cannot
          // be gifted, transferred, traded or sold.
          transferable: kind === 'OWNED',
          grantKey: `agency:${agencyId}:${input.idempotencyKey}`,
          expiresAt: shelf.expiresAt,
          metadata: { agencyId, distributionKind: kind },
        },
      });

      await tx.backpackLog.create({
        data: {
          userId: input.recipientId,
          itemId: backpackItem.id,
          action: 'GRANT',
          metadata: { agencyId, kind, quantity, name: shelf.name },
        },
      });

      return tx.agencyRewardDistribution.create({
        data: {
          agencyId,
          inventoryId: shelf.id,
          recipientId: input.recipientId,
          itemType: shelf.itemType,
          refId: shelf.refId,
          name: shelf.name,
          quantity,
          kind,
          backpackItemId: backpackItem.id,
          idempotencyKey: input.idempotencyKey,
          note: input.note ?? null,
        },
      });
    });
  }
}
