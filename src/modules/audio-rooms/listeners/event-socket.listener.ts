import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

const ENDED_STATUSES = new Set(['COMPLETED', 'CANCELLED']);

/**
 * Bridges the enterprise-events engine's generic `event.*` domain events
 * (published by EventEventService, string-named rather than typed classes —
 * see event-progression.listener.ts for the established precedent of
 * subscribing to them by literal name) into the `/audio-room` namespace, so a
 * super-admin "Launch" (status → ACTIVE) reaches every room without the
 * enterprise-events module needing any knowledge of sockets or rooms.
 *
 * Broadcast namespace-wide rather than to a specific room: events are
 * launched globally/by-region (see EventService.getActiveEventsForUser), not
 * scoped to a single room, so there is no room channel to target.
 */
@Injectable()
export class EventSocketListener implements OnModuleInit {
  private readonly logger = new Logger(EventSocketListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // The manual super-admin "Launch"/"End" path (EventService.updateStatus).
    this.bus.subscribe('event.updated', (e) => void this.handleUpdated(e.payload));
    this.bus.subscribe('event.cancelled', (e) => void this.handleEnded(e.payload));
    // The scheduler's time-window-driven path (EventSchedulerService) publishes
    // distinct event names for the same two transitions rather than reusing
    // 'event.updated' — both must be covered or a time-triggered start/end
    // (as opposed to a manual Launch/Cancel) would never reach the rooms.
    this.bus.subscribe('event.started', (e) => void this.handleStarted(e.payload));
    this.bus.subscribe('event.completed', (e) => void this.handleEnded(e.payload));
  }

  private async handleUpdated(payload: unknown): Promise<void> {
    const { eventId, changes } = (payload ?? {}) as {
      eventId?: string;
      changes?: { status?: string };
    };
    const status = changes?.status;
    if (!eventId || !status) return;

    if (status === 'ACTIVE') {
      await this.handleStarted({ eventId });
    } else if (ENDED_STATUSES.has(status)) {
      await this.handleEnded({ eventId });
    }
  }

  private async handleStarted(payload: unknown): Promise<void> {
    const { eventId } = (payload ?? {}) as { eventId?: string };
    if (!eventId) return;
    try {
      const event = await this.prisma.eventDefinition.findUnique({ where: { id: eventId } });
      if (!event) return;
      this.sockets.emitToNamespace(AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS.EVENT_LIVE, {
        eventId: event.id,
        code: event.code,
        name: event.name,
        category: event.category,
        banner: event.banner,
        thumbnail: event.thumbnail,
        countryId: event.countryId,
        regionId: event.regionId,
        startTime: event.startTime,
        endTime: event.endTime,
      });
    } catch (err) {
      this.logger.error(
        `Failed to broadcast launch for event ${eventId}: ${(err as Error).message}`,
      );
    }
  }

  private async handleEnded(payload: unknown): Promise<void> {
    const { eventId } = (payload ?? {}) as { eventId?: string };
    if (!eventId) return;
    this.sockets.emitToNamespace(AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS.EVENT_ENDED, { eventId });
  }
}
