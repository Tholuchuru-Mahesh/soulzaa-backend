import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_TREASURE_EVENTS } from '../events/video-room-treasure.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Bus event name → the `VideoRoomEvent.eventType` written for it. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_TREASURE_EVENTS.CREATED]: 'treasure.created',
  [VIDEO_ROOM_TREASURE_EVENTS.STARTED]: 'treasure.started',
  [VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED]: 'treasure.progress',
  [VIDEO_ROOM_TREASURE_EVENTS.REWARD_GENERATED]: 'treasure.pool_generated',
  [VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED]: 'treasure.winner_selected',
  [VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED]: 'treasure.reward_distributed',
  [VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED]: 'treasure.unlocked',
  [VIDEO_ROOM_TREASURE_EVENTS.CLOSED]: 'treasure.closed',
  [VIDEO_ROOM_TREASURE_EVENTS.RECOVERED]: 'treasure.recovered',
  [VIDEO_ROOM_TREASURE_EVENTS.UNLOCK_FAILED]: 'treasure.failed',
};

/** Payload fields that name the acting user, in precedence order. */
const ACTOR_FIELDS = ['createdBy', 'startedBy', 'closedBy', 'actorId'] as const;

/**
 * Writes the treasure audit trail into the existing append-only VideoRoomEvent
 * store (VR-11 spec §9). No new log table: `eventType` there is an open string,
 * and `correlationId` already groups one causal flow — so a whole unlock, from
 * pool generation through every payout, reads back as one chain.
 *
 * Failures are swallowed. Audit is observational; the money has already moved by
 * the time these fire, and throwing would poison the bus for every other
 * subscriber — including the socket bridge that tells winners they won.
 */
@Injectable()
export class VideoRoomTreasureAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomTreasureAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    for (const [busName, eventType] of Object.entries(AUDITED)) {
      this.bus.subscribe<DomainEvent<Record<string, unknown>>>(busName, (e) =>
        this.append(eventType, e.payload),
      );
    }
  }

  private async append(eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const { correlationId, roomId, sessionId, boxId, requestId, ...rest } = payload;
      await this.events.appendEvent({
        roomId: roomId as string,
        eventType,
        // Prefer the box: it is the finest-grained entity an auditor traces by.
        referenceId: (boxId as string) ?? (sessionId as string) ?? null,
        correlationId: (correlationId as string) ?? null,
        actorId: this.actorOf(payload),
        // `requestId` is preserved explicitly rather than swept into `rest`, so
        // an auditor can join a treasure row back to the HTTP access log. It is
        // null on the unlock chain by nature — those events are raised on a
        // queue worker, where `correlationId` is the meaningful identifier.
        payload: {
          sessionId,
          boxId,
          requestId: requestId ?? null,
          ...rest,
        } as Prisma.InputJsonValue,
      });
    } catch (err) {
      this.logger.warn(`Treasure audit append failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  private actorOf(payload: Record<string, unknown>): string | null {
    for (const field of ACTOR_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string') return value;
    }
    // Most treasure events are system-driven — gift progress, not a person acting.
    return null;
  }
}
