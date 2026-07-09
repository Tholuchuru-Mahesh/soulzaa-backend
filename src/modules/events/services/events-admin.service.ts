import { HttpStatus, Injectable } from '@nestjs/common';
import { EventType, PlatformEvent, Prisma } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { CreateEventDto, UpdateEventDto } from '../dto/events.dto';
import { EventsRepository } from '../repositories/events.repository';
import { EventsService } from './events.service';

/**
 * Platform-admin event configuration. Every mutation reloads the events service
 * in-memory cache so multiplier events and the public list reflect the change.
 */
@Injectable()
export class EventsAdminService {
  constructor(
    private readonly repo: EventsRepository,
    private readonly events: EventsService,
  ) {}

  async list(q: PaginationQueryDto & { type?: EventType }): Promise<Paginated<PlatformEvent>> {
    const [rows, total] = await this.repo.list(q.skip, q.limit, q.type);
    return buildPaginated(rows, total, q.page, q.limit);
  }

  async create(actorId: string, dto: CreateEventDto): Promise<PlatformEvent> {
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (end.getTime() <= start.getTime()) {
      throw new BusinessException(
        ERROR_CODES.EVENT_INVALID_WINDOW,
        'endAt must be after startAt.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const event = await this.repo.create(
      {
        name: dto.name,
        type: dto.type,
        description: dto.description ?? null,
        startAt: start,
        endAt: end,
        visibility: dto.visibility ?? 'PUBLIC',
        enabled: dto.enabled ?? true,
        rewards: (dto.rewards ?? []) as unknown as Prisma.InputJsonValue,
        multiplier: dto.multiplier ?? 1,
        eligibility: (dto.eligibility ?? undefined) as unknown as Prisma.InputJsonValue,
        bannerUrl: dto.bannerUrl ?? null,
      },
      actorId,
    );
    await this.events.reload();
    return event;
  }

  async update(actorId: string, id: string, dto: UpdateEventDto): Promise<PlatformEvent> {
    if (!(await this.repo.getEvent(id))) {
      throw new BusinessException(
        ERROR_CODES.EVENT_NOT_FOUND,
        'Event not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const data: Prisma.PlatformEventUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.startAt !== undefined ? { startAt: new Date(dto.startAt) } : {}),
      ...(dto.endAt !== undefined ? { endAt: new Date(dto.endAt) } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.rewards !== undefined
        ? { rewards: dto.rewards as unknown as Prisma.InputJsonValue }
        : {}),
      ...(dto.multiplier !== undefined ? { multiplier: dto.multiplier } : {}),
      ...(dto.eligibility !== undefined
        ? { eligibility: dto.eligibility as unknown as Prisma.InputJsonValue }
        : {}),
      ...(dto.bannerUrl !== undefined ? { bannerUrl: dto.bannerUrl } : {}),
    };
    const event = await this.repo.update(id, data, actorId);
    await this.events.reload();
    return event;
  }
}
