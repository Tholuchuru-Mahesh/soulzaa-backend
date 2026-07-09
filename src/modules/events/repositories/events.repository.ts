import { Injectable } from '@nestjs/common';
import { EventType, PlatformEvent, Prisma } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for events: the event configs + the immutable claim ledger. */
@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  getEvent(id: string): Promise<PlatformEvent | null> {
    return this.prisma.platformEvent.findUnique({ where: { id } });
  }

  /** All enabled events whose window contains `now` (for the multiplier cache). */
  listActive(now: Date): Promise<PlatformEvent[]> {
    return this.prisma.platformEvent.findMany({
      where: { enabled: true, startAt: { lte: now }, endAt: { gte: now } },
    });
  }

  /** Active PUBLIC events (user-facing list). */
  listActivePublic(now: Date): Promise<PlatformEvent[]> {
    return this.prisma.platformEvent.findMany({
      where: {
        enabled: true,
        visibility: 'PUBLIC',
        startAt: { lte: now },
        endAt: { gte: now },
      },
      orderBy: { endAt: 'asc' },
    });
  }

  list(skip: number, take: number, type?: EventType): Promise<[PlatformEvent[], number]> {
    const where: Prisma.PlatformEventWhereInput = { ...(type ? { type } : {}) };
    return this.prisma.$transaction([
      this.prisma.platformEvent.findMany({ where, skip, take, orderBy: { startAt: 'desc' } }),
      this.prisma.platformEvent.count({ where }),
    ]);
  }

  create(data: Prisma.PlatformEventUncheckedCreateInput, actorId: string): Promise<PlatformEvent> {
    return this.prisma.platformEvent.create({ data: { ...data, ...auditCreate(actorId) } });
  }

  update(
    id: string,
    data: Prisma.PlatformEventUpdateInput,
    actorId: string,
  ): Promise<PlatformEvent> {
    return this.prisma.platformEvent.update({
      where: { id },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  // ---- Claims ----

  findClaim(eventId: string, userId: string): Promise<{ id: string } | null> {
    return this.prisma.eventClaim.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { id: true },
    });
  }

  createClaim(data: {
    eventId: string;
    userId: string;
    rewardsSummary: Prisma.InputJsonValue;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    return this.prisma.eventClaim.create({ data, select: { id: true } });
  }

  listUserClaims(userId: string, skip: number, take: number): Promise<[unknown[], number]> {
    const where: Prisma.EventClaimWhereInput = { userId };
    return this.prisma.$transaction([
      this.prisma.eventClaim.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.eventClaim.count({ where }),
    ]);
  }

  async seedEvent(name: string, data: Prisma.PlatformEventUncheckedCreateInput): Promise<boolean> {
    const exists = await this.prisma.platformEvent.count({ where: { name } });
    if (exists > 0) return false;
    await this.prisma.platformEvent.create({ data });
    return true;
  }
}
