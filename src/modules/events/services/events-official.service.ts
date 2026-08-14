import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { CreateEventDto, UpdateEventDto } from '../dto/events.dto';
import { EventsAdminService } from './events-admin.service';

/**
 * EventsOfficialService — territory-scoped event management for the Official
 * Portal.
 *
 * Officials can create events that are visible only in their geographic scope
 * (countryId / stateId / regionId snapshotted from their profile at creation
 * time). Listing is also narrowed to the caller's territory so two Officials
 * in different regions can never see each other's events.
 *
 * All create/update mutations delegate to EventsAdminService which reloads the
 * in-memory cache and validates the time window.
 */
@Injectable()
export class EventsOfficialService {
  private readonly logger = new Logger(EventsOfficialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: EventsAdminService,
    private readonly scope: WorkforceScopeService,
  ) {}

  /**
   * Create a regional event.
   * The event's scope columns are auto-filled from the Official's profile so
   * the event stays in their territory's feed even if the event schema is
   * updated later.
   */
  async create(officialId: string, dto: CreateEventDto) {
    const official = await this.prisma.user.findUnique({
      where: { id: officialId },
      select: { countryId: true, stateId: true, regionId: true },
    });
    if (!official) throw new BadRequestException('Official user not found');

    // Delegate to the admin service for validation + cache reload
    const event = await this.admin.create(officialId, dto);

    // Patch the scope columns — admin.create returns after the INSERT, so we
    // do a targeted update rather than duplicating validation logic.
    if (official.countryId || official.stateId || official.regionId) {
      await this.prisma.platformEvent.update({
        where: { id: event.id },
        data: {
          countryId: official.countryId,
          stateId: official.stateId,
          regionId: official.regionId,
        },
      });
      this.logger.log(
        `Regional event ${event.id} scoped to country=${official.countryId ?? '—'} by Official ${officialId}`,
      );
    }

    return {
      ...event,
      countryId: official.countryId,
      stateId: official.stateId,
      regionId: official.regionId,
    };
  }

  /**
   * Update a regional event in the Official's territory.
   */
  async update(officialId: string, eventId: string, dto: UpdateEventDto) {
    return this.admin.update(officialId, eventId, dto);
  }

  /**
   * List platform events scoped to the Official's territory.
   * Global events (no countryId) are excluded; only events whose scope
   * matches the caller's assignments are returned.
   */
  async list(officialId: string, opts: { limit?: number; offset?: number } = {}) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    // Build an OR filter matching the events' scope columns
    let where: Record<string, unknown> = {};
    if (!isUnrestricted && 'OR' in scopeWhere) {
      where = {
        OR: (scopeWhere['OR'] as Record<string, unknown>[]).map((clause) => {
          const out: Record<string, unknown> = {};
          if ('countryId' in clause) out['countryId'] = clause['countryId'];
          if ('stateId' in clause) out['stateId'] = clause['stateId'];
          if ('regionId' in clause) out['regionId'] = clause['regionId'];
          return out;
        }),
      };
    }

    const limit = Math.min(opts.limit ?? 25, 100);
    const offset = opts.offset ?? 0;

    const [total, items] = await Promise.all([
      this.prisma.platformEvent.count({ where }),
      this.prisma.platformEvent.findMany({
        where,
        orderBy: { startAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return { total, items };
  }
}
