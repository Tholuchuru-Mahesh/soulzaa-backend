import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ContentRequestStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { CreateContentRequestDto, UpdateContentRequestDto } from '../dto/content-request.dto';

/**
 * Content Request service — Officials create and manage content review
 * requests for users/content in their territory.
 *
 * Every request is geo-anchored to the Official's territory at creation
 * time so the queue stays in scope even if the Official's assignment changes.
 */
@Injectable()
export class ContentRequestService {
  private readonly logger = new Logger(ContentRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
    @Optional() private readonly socketManager?: SocketManager,
  ) {}

  /**
   * Create a new content request.
   * Snapshots the Official's current geographic scope so the request stays
   * in their territory's queue.
   */
  async create(officialId: string, dto: CreateContentRequestDto) {
    // Snapshot official's location
    const [official, roleScope] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: officialId },
        select: { countryId: true, stateId: true, regionId: true },
      }),
      this.prisma.roleScope.findFirst({
        where: { userRole: { userId: officialId } },
      }),
    ]);

    if (!official) throw new BadRequestException('Official user not found');

    const countryId = roleScope?.countryId ?? official.countryId;
    const stateId = roleScope?.stateId ?? official.stateId;
    const regionId = roleScope?.regionId ?? official.regionId;

    const request = await this.prisma.contentRequest.create({
      data: {
        officialId,
        category: dto.category ?? 'OTHER',
        title: dto.title,
        description: dto.description,
        subjectId: dto.subjectId,
        referenceId: dto.referenceId,
        metadata: dto.metadata ?? {},
        countryId,
        stateId,
        regionId,
        status: 'OPEN',
      },
    });

    this.logger.log(`Content request ${request.id} created by Official ${officialId}`);
    try {
      this.socketManager?.emitToNamespace('/notifications', 'content_requests:update', {
        action: 'create',
        request,
      });
    } catch {
      // socket non-blocking
    }

    return request;
  }

  /**
   * List content requests scoped to the Official's territory.
   * Filters by status if provided.
   */
  async list(
    officialId: string,
    opts: {
      status?: ContentRequestStatus;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    // Build a location filter from the scope predicate
    const locationFilter = isUnrestricted ? {} : this.buildLocationFilter(scopeWhere);

    const baseWhere = {
      ...locationFilter,
    };

    const where = {
      ...baseWhere,
      ...(opts.status ? { status: opts.status } : {}),
    };

    const limit = Math.min(opts.limit ?? 50, 100);
    const offset = opts.offset ?? 0;

    const [total, items, pendingCount, approvedCount, rejectedCount] = await Promise.all([
      this.prisma.contentRequest.count({ where }),
      this.prisma.contentRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.contentRequest.count({
        where: { ...baseWhere, status: { in: ['OPEN', 'IN_REVIEW'] } },
      }),
      this.prisma.contentRequest.count({
        where: { ...baseWhere, status: 'APPROVED' },
      }),
      this.prisma.contentRequest.count({
        where: { ...baseWhere, status: 'REJECTED' },
      }),
    ]);

    return {
      total,
      items,
      metrics: {
        all: total,
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
      },
    };
  }

  /** Find a single content request by ID. */
  async findById(id: string) {
    const request = await this.prisma.contentRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException(`Content request ${id} not found`);
    return request;
  }

  /** Update request details (Official or Admin). */
  async update(id: string, actorId: string, dto: UpdateContentRequestDto) {
    await this.findById(id);

    const updated = await this.prisma.contentRequest.update({
      where: { id },
      data: {
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.metadata ? { metadata: dto.metadata } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
    });

    this.logger.log(`Content request ${id} updated by ${actorId}`);
    try {
      this.socketManager?.emitToNamespace('/notifications', 'content_requests:update', {
        action: 'update',
        request: updated,
      });
    } catch {
      // socket non-blocking
    }

    return updated;
  }

  /**
   * Update a content request's status (OPEN/IN_REVIEW → APPROVED / REJECTED / RESOLVED).
   */
  async updateStatus(id: string, actorId: string, dto: UpdateContentRequestDto) {
    // Existence guard — `findById` throws when the request is missing.
    await this.findById(id);

    const extra: Record<string, unknown> = {};
    if (dto.status === 'RESOLVED' || dto.status === 'APPROVED') extra['resolvedAt'] = new Date();
    if (dto.status === 'RESOLVED' || dto.status === 'REJECTED' || dto.status === 'APPROVED') {
      extra['closedById'] = actorId;
    }

    const updated = await this.prisma.contentRequest.update({
      where: { id },
      data: { status: dto.status, ...extra },
    });

    this.logger.log(`Content request ${id} status → ${dto.status} by ${actorId}`);
    try {
      this.socketManager?.emitToNamespace('/notifications', 'content_requests:update', {
        action: 'status_update',
        request: updated,
      });
    } catch {
      // socket non-blocking
    }

    return updated;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildLocationFilter(scopeWhere: Record<string, unknown>): Record<string, unknown> {
    if (!('OR' in scopeWhere)) return {};
    return {
      OR: (scopeWhere['OR'] as Record<string, unknown>[]).map((clause) => {
        const out: Record<string, unknown> = {};
        if ('countryId' in clause) out['countryId'] = clause['countryId'];
        if ('stateId' in clause) out['stateId'] = clause['stateId'];
        if ('regionId' in clause) out['regionId'] = clause['regionId'];
        return out;
      }),
    };
  }
}
