import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';

const MAX_PAGE_SIZE = 100;

/**
 * The agency's own audit trail.
 *
 * Read-only by design: the spec requires audit rows to be permanently
 * traceable and neither modifiable nor deletable, so this service exposes no
 * write path at all. Every query is pinned to `actorId = the calling agency`,
 * which is what stops one agency reading another's trail.
 *
 * Distinct from `AgencyAuditService`, which *writes* settlement audit rows for
 * platform staff. This one only reads, and only the caller's own.
 */
@Injectable()
export class AgencyAuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /**
   * The agency's actions, newest first.
   *
   * [module] filters on the audited resource, [search] on the action name —
   * the two things the screen's filter row offers.
   */
  async list(
    agencyId: string,
    options: { module?: string; search?: string; page?: number; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_PAGE_SIZE);
    const page = Math.max(options.page ?? 1, 1);
    const search = options.search?.trim();

    const where = {
      actorId: agencyId,
      ...(options.module ? { resource: options.module } : {}),
      ...(search ? { action: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const names = await this.resolveTargets(rows);

    return {
      items: rows.map((row) => this.toEntry(row, names)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * One entry in full, including the device and network columns the list omits.
   *
   * Scoped to the caller's own rows: an audit id is a uuid, but guessing one
   * must not expose another agency's trail.
   */
  async get(agencyId: string, logId: string) {
    const row = await this.prisma.auditLog.findFirst({
      where: { id: logId, actorId: agencyId },
    });
    if (!row) {
      throw new NotFoundException('Audit log entry not found');
    }

    const names = await this.resolveTargets([row]);

    return {
      ...this.toEntry(row, names),
      // The forensic columns, which only the detail view shows.
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      browser: row.browser,
      os: row.os,
      region: row.region,
      // Free-form per action — rendered as label/value rows rather than
      // interpreted, so a new action type needs no client change.
      details: row.details ?? null,
    };
  }

  /** Which resources this agency has audit rows for, for the filter row. */
  async listModules(agencyId: string): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { actorId: agencyId },
      select: { resource: true },
      distinct: ['resource'],
      orderBy: { resource: 'asc' },
    });
    return rows.map((row) => row.resource);
  }

  /**
   * Display names for the users an entry acted on.
   *
   * Resolved in one query for the whole page rather than per row, and through
   * the profile seam so hidden accounts stay hidden.
   */
  private async resolveTargets(
    rows: Array<{ targetUserId: string | null }>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.targetUserId).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();

    const identities = await this.profiles.resolvePublicIdentities(ids);
    const names = new Map<string, string>();
    for (const [id, identity] of identities) {
      if (identity.displayName) names.set(id, identity.displayName);
    }
    return names;
  }

  private toEntry(
    row: {
      id: string;
      action: string;
      resource: string;
      resourceId: string | null;
      targetUserId: string | null;
      status: string;
      createdAt: Date;
    },
    names: Map<string, string>,
  ) {
    return {
      id: row.id,
      action: row.action,
      module: row.resource,
      // The row's own reference, so an entry can be traced back to the record
      // it describes.
      reference: row.resourceId,
      targetUserId: row.targetUserId,
      // Null when the entry acted on no user, or on one whose profile no longer
      // resolves — the client shows a dash rather than inventing a name.
      targetUserName: row.targetUserId ? (names.get(row.targetUserId) ?? null) : null,
      status: row.status,
      occurredAt: row.createdAt,
    };
  }
}
