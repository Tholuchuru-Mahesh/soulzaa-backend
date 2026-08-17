import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AgencyMemberService } from './agency-member.service';

const MAX_PAGE_SIZE = 100;

/**
 * The Overview tab's two history cards: rewards this agency has sent to the
 * member, and platform events the member has joined.
 *
 * Rewards are scoped to the calling agency as well as the recipient. A member
 * may belong to one agency and have received rewards from another in the past;
 * this agency is entitled to see what it sent, not what anybody else did.
 */
@Injectable()
export class AgencyMemberHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: AgencyMemberService,
  ) {}

  async getRewards(
    agencyId: string,
    userId: string,
    options: { page?: number; limit?: number } = {},
  ) {
    await this.members.assertMember(agencyId, userId);
    const { page, limit, skip } = this.paging(options);

    const where = { agencyId, recipientId: userId };
    const [rows, total] = await Promise.all([
      this.prisma.agencyRewardDistribution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          itemType: true,
          kind: true,
          note: true,
          quantity: true,
          createdAt: true,
        },
      }),
      this.prisma.agencyRewardDistribution.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        itemType: row.itemType,
        kind: row.kind,
        note: row.note,
        quantity: row.quantity,
        receivedAt: row.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getEvents(
    agencyId: string,
    userId: string,
    options: { page?: number; limit?: number } = {},
  ) {
    await this.members.assertMember(agencyId, userId);
    const { page, limit, skip } = this.paging(options);

    const where = { userId };
    const [rows, total] = await Promise.all([
      this.prisma.eventParticipant.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        skip,
        take: limit,
        select: {
          eventId: true,
          status: true,
          completedAt: true,
          joinedAt: true,
          event: { select: { name: true, thumbnail: true, startTime: true } },
        },
      }),
      this.prisma.eventParticipant.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        eventId: row.eventId,
        name: row.event?.name ?? null,
        thumbnailUrl: row.event?.thumbnail ?? null,
        startTime: row.event?.startTime ?? null,
        joinedAt: row.joinedAt,
        // Derived from the timestamp rather than trusted from `status`, so an
        // event still marked PARTICIPATING but finished does not show as live.
        status: row.completedAt ? 'COMPLETED' : row.status,
        completedAt: row.completedAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Same clamping as `AgencyMemberService.listMembers`. */
  private paging(options: { page?: number; limit?: number }) {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);
    return { page, limit, skip: (page - 1) * limit };
  }
}
