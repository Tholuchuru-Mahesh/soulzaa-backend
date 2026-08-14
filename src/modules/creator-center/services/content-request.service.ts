import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContentRequestStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import {
  CreateContentRequestDto,
  UpdateContentRequestDto,
} from '../dto/content-request.dto';

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
  ) {}

  /**
   * Create a new content request.
   * Snapshots the Official's current geographic scope so the request stays
   * in their territory's queue.
   */
  async create(officialId: string, dto: CreateContentRequestDto) {
    // Snapshot official's location
    const official = await this.prisma.user.findUnique({
      where: { id: officialId },
      select: { countryId: true, stateId: true, regionId: true },
    });
    if (!official) throw new BadRequestException('Official user not found');

    const request = await this.prisma.contentRequest.create({
      data: {
        officialId,
        category: dto.category,
        title: dto.title,
        description: dto.description,
        subjectId: dto.subjectId,
        referenceId: dto.referenceId,
        countryId: official.countryId,
        stateId: official.stateId,
        regionId: official.regionId,
      },
    });

    this.logger.log(
      `Content request ${request.id} created by Official ${officialId}`,
    );
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
    const locationFilter = isUnrestricted
      ? {}
      : this.buildLocationFilter(scopeWhere);

    const where = {
      ...locationFilter,
      ...(opts.status ? { status: opts.status } : {}),
    };

    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = opts.offset ?? 0;

    const [total, items] = await Promise.all([
      this.prisma.contentRequest.count({ where }),
      this.prisma.contentRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  /** Find a single content request by ID. */
  async findById(id: string) {
    const request = await this.prisma.contentRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException(`Content request ${id} not found`);
    return request;
  }

  /**
   * Update a content request's status (IN_REVIEW → RESOLVED / REJECTED).
   */
  async updateStatus(
    id: string,
    actorId: string,
    dto: UpdateContentRequestDto,
  ) {
    const request = await this.findById(id);

    const terminal: ContentRequestStatus[] = ['RESOLVED', 'REJECTED'];
    if (terminal.includes(request.status)) {
      throw new BadRequestException(`Request is already ${request.status}`);
    }

    const extra: Record<string, unknown> = {};
    if (dto.status === 'RESOLVED') extra['resolvedAt'] = new Date();
    if (dto.status === 'RESOLVED' || dto.status === 'REJECTED') {
      extra['closedById'] = actorId;
    }

    const updated = await this.prisma.contentRequest.update({
      where: { id },
      data: { status: dto.status, ...extra },
    });

    this.logger.log(
      `Content request ${id} status → ${dto.status} by ${actorId}`,
    );
    return updated;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildLocationFilter(
    scopeWhere: Record<string, unknown>,
  ): Record<string, unknown> {
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
