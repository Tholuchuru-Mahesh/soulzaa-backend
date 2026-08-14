import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import {
  CreateCommunityProgramDto,
  UpdateCommunityProgramDto,
} from '../dto/campaign.dto';

/**
 * Community Program service — Officials create and manage ongoing
 * community-engagement programs (creator bootcamps, moderation drives,
 * charity streams, etc.) within their territory.
 */
@Injectable()
export class CommunityProgramService {
  private readonly logger = new Logger(CommunityProgramService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
  ) {}

  async create(officialId: string, dto: CreateCommunityProgramDto) {
    const official = await this.prisma.user.findUnique({
      where: { id: officialId },
      select: { countryId: true, stateId: true, regionId: true },
    });
    if (!official) throw new NotFoundException('Official user not found');

    const program = await this.prisma.communityProgram.create({
      data: {
        createdById: officialId,
        name: dto.name,
        description: dto.description,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        endAt: dto.endAt ? new Date(dto.endAt) : undefined,
        countryId: official.countryId,
        stateId: official.stateId,
        regionId: official.regionId,
      },
    });

    this.logger.log(
      `Community program ${program.id} created by Official ${officialId}`,
    );
    return program;
  }

  async list(
    officialId: string,
    opts: { isActive?: boolean; limit?: number; offset?: number } = {},
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    const locationFilter = isUnrestricted
      ? {}
      : this.buildLocationFilter(scopeWhere);

    const where = {
      ...locationFilter,
      ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
    };

    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = opts.offset ?? 0;

    const [total, items] = await Promise.all([
      this.prisma.communityProgram.count({ where }),
      this.prisma.communityProgram.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  async findById(id: string) {
    const program = await this.prisma.communityProgram.findUnique({
      where: { id },
    });
    if (!program) throw new NotFoundException(`Community program ${id} not found`);
    return program;
  }

  async update(id: string, actorId: string, dto: UpdateCommunityProgramDto) {
    await this.findById(id);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data['name'] = dto.name;
    if (dto.description !== undefined) data['description'] = dto.description;
    if (dto.isActive !== undefined) data['isActive'] = dto.isActive;
    if (dto.startAt !== undefined) data['startAt'] = new Date(dto.startAt);
    if (dto.endAt !== undefined) data['endAt'] = new Date(dto.endAt);

    const updated = await this.prisma.communityProgram.update({
      where: { id },
      data,
    });

    this.logger.log(`Community program ${id} updated by ${actorId}`);
    return updated;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

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
