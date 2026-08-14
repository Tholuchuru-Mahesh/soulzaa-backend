import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { CreateCampaignDto, UpdateCampaignDto } from '../dto/campaign.dto';

/**
 * Campaign service — Officials create and manage time-bounded promotional or
 * engagement campaigns in their territory.
 *
 * Every campaign is geo-anchored at creation from the Official's profile.
 */
@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
  ) {}

  async create(officialId: string, dto: CreateCampaignDto) {
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (end <= start) {
      throw new BadRequestException('endAt must be after startAt');
    }

    const official = await this.prisma.user.findUnique({
      where: { id: officialId },
      select: { countryId: true, stateId: true, regionId: true },
    });
    if (!official) throw new BadRequestException('Official user not found');

    const campaign = await this.prisma.campaign.create({
      data: {
        createdById: officialId,
        title: dto.title,
        description: dto.description,
        startAt: start,
        endAt: end,
        countryId: official.countryId,
        stateId: official.stateId,
        regionId: official.regionId,
      },
    });

    this.logger.log(`Campaign ${campaign.id} created by Official ${officialId}`);
    return campaign;
  }

  async list(
    officialId: string,
    opts: { status?: CampaignStatus; limit?: number; offset?: number } = {},
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    const locationFilter = isUnrestricted ? {} : this.buildLocationFilter(scopeWhere);

    const where = {
      ...locationFilter,
      ...(opts.status ? { status: opts.status } : {}),
    };

    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = opts.offset ?? 0;

    const [total, items] = await Promise.all([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        orderBy: { startAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  async findById(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  async update(id: string, actorId: string, dto: UpdateCampaignDto) {
    await this.findById(id);

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data['title'] = dto.title;
    if (dto.description !== undefined) data['description'] = dto.description;
    if (dto.status !== undefined) data['status'] = dto.status;
    if (dto.startAt !== undefined) data['startAt'] = new Date(dto.startAt);
    if (dto.endAt !== undefined) data['endAt'] = new Date(dto.endAt);

    if (data['startAt'] && data['endAt'] && data['endAt'] <= data['startAt']) {
      throw new BadRequestException('endAt must be after startAt');
    }

    const updated = await this.prisma.campaign.update({ where: { id }, data });
    this.logger.log(`Campaign ${id} updated by ${actorId}`);
    return updated;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

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
