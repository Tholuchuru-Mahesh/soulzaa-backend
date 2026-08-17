import { Injectable, Logger } from '@nestjs/common';
import { SupportTicketCategory, SupportTicketPriority, SupportTicketStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

@Injectable()
export class SupportTicketQueryService {
  private readonly logger = new Logger(SupportTicketQueryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
  ) {}

  /**
   * Paginated ticket list scoped to the Official's territory.
   * SUPER_ADMIN / ADMIN (unrestricted scope) see all tickets.
   */
  async listForOfficial(
    officialId: string,
    opts: {
      status?: SupportTicketStatus;
      category?: SupportTicketCategory;
      priority?: SupportTicketPriority;
      limit: number;
      offset: number;
    },
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    // Build location filter for tickets — mirror the same column set
    // (countryId/stateId/regionId) that the user scope filter targets.
    let locationFilter: Record<string, unknown> = {};
    if (!isUnrestricted && 'OR' in scopeWhere) {
      const clauses = (scopeWhere as { OR: Array<Record<string, unknown>> }).OR;
      if (Array.isArray(clauses) && clauses.length > 0) {
        const mapped = clauses
          .map((clause) => {
            const out: Record<string, unknown> = {};
            if ('countryId' in clause && clause['countryId'] !== undefined) out['countryId'] = clause['countryId'];
            if ('stateId' in clause && clause['stateId'] !== undefined) out['stateId'] = clause['stateId'];
            if ('regionId' in clause && clause['regionId'] !== undefined) out['regionId'] = clause['regionId'];
            return out;
          })
          .filter((obj) => Object.keys(obj).length > 0);

        if (mapped.length > 0) {
          locationFilter = {
            OR: [
              ...mapped,
              { countryId: null },
              { stateId: null },
            ],
          };
        }
      }
    }

    const where = {
      ...locationFilter,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.priority ? { priority: opts.priority } : {}),
    };

    const [total, rawItems] = await Promise.all([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { priority: 'desc' }],
        take: Math.min(opts.limit, 100),
        skip: opts.offset,
        select: {
          id: true,
          submitterId: true,
          title: true,
          description: true,
          category: true,
          priority: true,
          status: true,
          assignedOfficialId: true,
          countryId: true,
          stateId: true,
          regionId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      }),
    ]);

    const submitterIds = Array.from(new Set(rawItems.map((item) => item.submitterId)));
    const users = submitterIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: submitterIds } },
          select: { id: true, username: true, fullName: true },
        })
      : [];

    const userMap = new Map(users.map((u) => [u.id, u]));

    const items = rawItems.map((item) => {
      const user = userMap.get(item.submitterId);
      return {
        ...item,
        submitter: user ? {
          id: user.id,
          username: user.username,
          name: user.fullName || user.username,
          avatarUrl: null,
        } : null,
      };
    });

    return { total, items };
  }

  /** Single ticket with full message thread, for Official or submitter. */
  async findById(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        audits: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!ticket) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: ticket.submitterId },
      select: { id: true, username: true, fullName: true },
    });

    return {
      ...ticket,
      submitter: user
        ? {
            id: user.id,
            username: user.username,
            name: user.fullName || user.username,
            avatarUrl: null,
          }
        : null,
    };
  }

  /**
   * One ticket, readable only by the person who raised it.
   *
   * Separate from `findById`, which is the staff read and returns any ticket:
   * this is what the submitter's own detail screen uses, so the submitter id is
   * part of the query rather than a check applied afterwards. Internal audit
   * rows are deliberately excluded — they record staff handling and are not the
   * submitter's to see.
   */
  async findOwnById(ticketId: string, submitterId: string) {
    return this.prisma.supportTicket.findFirst({
      where: { id: ticketId, submitterId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  /** Count open tickets in an Official's territory (used by dashboard). */
  async countOpenInScope(officialId: string): Promise<number> {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let locationFilter: Record<string, unknown> = {};
    if (!isUnrestricted && 'OR' in scopeWhere) {
      const clauses = (scopeWhere as { OR: Array<Record<string, unknown>> }).OR;
      if (Array.isArray(clauses) && clauses.length > 0) {
        const mapped = clauses
          .map((clause) => {
            const out: Record<string, unknown> = {};
            if ('countryId' in clause && clause['countryId'] !== undefined) out['countryId'] = clause['countryId'];
            if ('stateId' in clause && clause['stateId'] !== undefined) out['stateId'] = clause['stateId'];
            if ('regionId' in clause && clause['regionId'] !== undefined) out['regionId'] = clause['regionId'];
            return out;
          })
          .filter((obj) => Object.keys(obj).length > 0);

        if (mapped.length > 0) {
          locationFilter = {
            OR: [
              ...mapped,
              { countryId: null },
              { stateId: null },
            ],
          };
        }
      }
    }

    return this.prisma.supportTicket.count({
      where: {
        ...locationFilter,
        status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] },
      },
    });
  }

  /** Tickets submitted by a specific user. */
  async listBySubmitter(submitterId: string, limit = 25, offset = 0) {
    const [total, items] = await Promise.all([
      this.prisma.supportTicket.count({ where: { submitterId } }),
      this.prisma.supportTicket.findMany({
        where: { submitterId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          title: true,
          category: true,
          priority: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
        },
      }),
    ]);
    return { total, items };
  }
}
