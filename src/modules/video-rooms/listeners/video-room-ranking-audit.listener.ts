import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { errorMessage } from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from '../constants/video-room.constants';
import { VIDEO_ROOM_RANKING_EVENTS } from '../events/video-room-ranking.events';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';

/** Bus event name → the `VideoRoomEvent.eventType` written for it. */
const AUDITED: Record<string, string> = {
  [VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED]: 'ranking.updated',
  [VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED]: 'ranking.leaderboard_changed',
  [VIDEO_ROOM_RANKING_EVENTS.AGGREGATED]: 'ranking.aggregated',
  [VIDEO_ROOM_RANKING_EVENTS.SNAPSHOT_CREATED]: 'ranking.snapshot_created',
};

/**
 * Writes the ranking audit trail into the existing append-only VideoRoomEvent
 * store — no new log table, mirroring VideoRoomTreasureAuditListener.
 *
 * Only the four LIFECYCLE events are audited, deliberately. The per-dimension
 * movement events fire on every gift; auditing those would write a row per gift
 * per dimension, duplicating gift_transactions at four times its volume and
 * burying the aggregation history an auditor actually reads.
 *
 * Failures are swallowed. Audit is observational, and throwing would poison the
 * bus for the socket bridge and the metrics listener.
 */
@Injectable()
export class VideoRoomRankingAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomRankingAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly events: VideoRoomEventsRepository,
  ) {}

  onModuleInit(): void {
    for (const [busName, eventType] of Object.entries(AUDITED)) {
      this.bus.subscribe<DomainEvent<Record<string, unknown>>>(busName, (e) =>
        this.append(eventType, e.payload, e.eventId),
      );
    }
  }

  private async append(
    eventType: string,
    payload: Record<string, unknown>,
    eventId: string,
  ): Promise<void> {
    try {
      const { roomId, scope, dimension, period, dateKey, requestId, ...rest } = payload;

      // A global-scope ranking event has no room. VideoRoomEvent.roomId is
      // required, so those are dropped rather than written against a fake room.
      if (!roomId) return;

      await this.events.appendEvent({
        roomId: roomId as string,
        eventType,
        // The ladder coordinates are what an auditor traces by.
        referenceId: `${scope as string}:${dimension as string}:${period as string}:${dateKey as string}`,
        correlationId: eventId,
        // Rankings move on their own; no human is the actor.
        actorId: VIDEO_ROOM_SYSTEM_ACTOR_ID,
        payload: {
          scope,
          dimension,
          period,
          dateKey,
          requestId: requestId ?? null,
          ...rest,
        } as Prisma.InputJsonValue,
      });
    } catch (err) {
      this.logger.warn(`ranking audit append failed (${eventType}): ${errorMessage(err)}`);
    }
  }
}
