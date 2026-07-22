import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, VideoRoomLogAction } from '@prisma/client';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { VIDEO_ROOM_PK_EVENTS } from '../events/video-room-pk.events';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';

/** Bus event name → the `VideoRoomLog.action` written for it (Task 2's 9 `PK_*` values). */
const AUDITED: Record<string, VideoRoomLogAction> = {
  [VIDEO_ROOM_PK_EVENTS.INVITATION_SENT]: VideoRoomLogAction.PK_INVITED,
  [VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED]: VideoRoomLogAction.PK_INVITATION_ACCEPTED,
  [VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED]: VideoRoomLogAction.PK_INVITATION_REJECTED,
  [VIDEO_ROOM_PK_EVENTS.STARTED]: VideoRoomLogAction.PK_STARTED,
  [VIDEO_ROOM_PK_EVENTS.PAUSED]: VideoRoomLogAction.PK_PAUSED,
  [VIDEO_ROOM_PK_EVENTS.RESUMED]: VideoRoomLogAction.PK_RESUMED,
  [VIDEO_ROOM_PK_EVENTS.ENDED]: VideoRoomLogAction.PK_ENDED,
  [VIDEO_ROOM_PK_EVENTS.RECOVERED]: VideoRoomLogAction.PK_RECOVERED,
  [VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED]: VideoRoomLogAction.PK_REWARD_DISTRIBUTED,
};

/** Payload fields that name the acting user, in precedence order. */
const ACTOR_FIELDS = ['inviterUserId', 'inviteeUserId', 'createdBy'] as const;

/**
 * Writes the PK audit trail into `video_room_logs` (VR-12 Task 23), using the
 * 9 `PK_*` `VideoRoomLogAction` values Task 2 added.
 *
 * Unlike the VR-11 treasure listener, PK has no companion append-only
 * `VideoRoomEvent` stream to also write — `VideoRoomLogAction` is the whole
 * audit surface here, so `VideoRoomsRepository.appendLog` is the only write
 * path (never Prisma directly).
 *
 * `CREATED`, `SCORE_UPDATED` and `WINNER_DECLARED` are deliberately
 * unaudited: `CREATED` fires before any invitation exists (nothing yet to
 * review), `SCORE_UPDATED` is gift-volume traffic that would drown a
 * moderator trail in noise, and `WINNER_DECLARED`'s
 * `{winningTeamId, isDraw, winners}` is a strict subset of what `PK_ENDED`
 * and `PK_REWARD_DISTRIBUTED` already carry.
 *
 * `requestId` closes VR-12's Task 17/Task 23 gap: the lifecycle service
 * (`VideoRoomPkService`) now populates the optional `PkEventBase.requestId`
 * on the events it publishes directly (CREATED, STARTED, PAUSED, RESUMED), so
 * an auditor can join a `PK_STARTED`/`PK_PAUSED`/`PK_RESUMED` row back to the
 * HTTP access log. Events published by services outside this task's file
 * scope (invitations, scoring, settlement, recovery) do not yet carry one and
 * record `null` — an honest gap, not a silent guess.
 *
 * Failures are swallowed. Audit is observational; the battle's state or money
 * has already moved by the time these fire, and throwing would poison the bus
 * for every other subscriber — including the socket bridge that tells
 * players the outcome.
 */
@Injectable()
export class VideoRoomPkAuditListener implements OnModuleInit {
  private readonly logger = new Logger(VideoRoomPkAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly rooms: VideoRoomsRepository,
  ) {}

  onModuleInit(): void {
    for (const [busName, action] of Object.entries(AUDITED)) {
      this.bus.subscribe<DomainEvent<Record<string, unknown>>>(busName, (e) =>
        this.append(action, e.payload, e.occurredAt),
      );
    }
  }

  private async append(
    action: VideoRoomLogAction,
    payload: Record<string, unknown>,
    occurredAt: string,
  ): Promise<void> {
    try {
      const { roomId, battleId, requestId, ...rest } = payload;
      await this.rooms.appendLog({
        roomId: roomId as string,
        actorId: this.actorOf(payload),
        action,
        metadata: {
          battleId,
          timestamp: occurredAt,
          requestId: (requestId as string | undefined) ?? null,
          ...rest,
        } as Prisma.InputJsonValue,
      });
    } catch (err) {
      this.logger.warn(`PK audit append failed for ${action}: ${(err as Error).message}`);
    }
  }

  private actorOf(payload: Record<string, unknown>): string | null {
    for (const field of ACTOR_FIELDS) {
      const value = payload[field];
      if (typeof value === 'string') return value;
    }
    // Most audited PK events are system/settlement-driven — PAUSED, RESUMED,
    // ENDED, RECOVERED and REWARD_DISTRIBUTED carry no actor field in Task
    // 6's schema — so null is the honest answer, not a guess.
    return null;
  }
}
