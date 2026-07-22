import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_PK_SOCKET_EVENTS } from '../constants/video-room-pk.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkEndedEvent,
  type PkInvitationAcceptedEvent,
  type PkInvitationRejectedEvent,
  type PkInvitationSentEvent,
  type PkPausedEvent,
  type PkRecoveredEvent,
  type PkResumedEvent,
  type PkRewardDistributedEvent,
  type PkScoreUpdatedEvent,
  type PkStartedEvent,
  type PkWinnerDeclaredEvent,
} from '../events/video-room-pk.events';

/**
 * Bridges PK battle events to the `/video-room` sockets (VR-12 Task 23).
 * Follows the VR-10/VR-11 pattern: no domain gateway — inbound is the shared
 * BaseGateway, outbound is EVENT_BUS relayed here.
 *
 * 11 of the 12 domain events cross the wire. `PkCreatedEvent` is deliberately
 * NOT bridged (see its subscription slot below for why).
 *
 * `pkCountdown` and `pkWinner` are socket names with no exact 1:1 domain
 * event: `pkCountdown` is derived from `PkStartedEvent`'s own
 * `countdownSeconds` (mirrors the treasure listener's UNLOCKED → UNLOCKED +
 * ANIMATION + LEVEL_CHANGED fan-out), and `pkWinner` carries BOTH
 * `PkWinnerDeclaredEvent` and `PkRewardDistributedEvent` — settlement
 * publishes them back to back (see `VideoRoomPkSettlementService.settle`),
 * and the Task 3 socket vocabulary has no separate reward-distributed event
 * for clients that only care "who won and what they got".
 */
@Injectable()
export class VideoRoomPkSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PkInvitationSentEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_SENT, e.payload),
    );

    this.bus.subscribe<PkInvitationAcceptedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_ACCEPTED, e.payload),
    );

    this.bus.subscribe<PkInvitationRejectedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_REJECTED, e.payload),
    );

    // PkCreatedEvent is deliberately NOT bridged: it fires the instant a
    // battle row + invitations are created, before `invitations.send()` has
    // told anyone about it (VideoRoomPkService.invite). Broadcasting it would
    // announce a battle to the room that no client can yet accept, reject, or
    // watch. INVITATION_SENT is the first PK signal a client should ever see.

    this.bus.subscribe<PkStartedEvent>(VIDEO_ROOM_PK_EVENTS.STARTED, (e) => {
      const p = e.payload;
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.STARTED, p);
      // A separate countdown trigger, derived from the same payload, so a
      // client driving only the countdown UI need not parse the full
      // started-battle payload.
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.COUNTDOWN, {
        roomId: p.roomId,
        battleId: p.battleId,
        countdownSeconds: p.countdownSeconds,
        startedAt: p.startedAt,
      });
    });

    this.bus.subscribe<PkScoreUpdatedEvent>(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.SCORE_UPDATED, e.payload),
    );

    this.bus.subscribe<PkPausedEvent>(VIDEO_ROOM_PK_EVENTS.PAUSED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.PAUSED, e.payload),
    );

    this.bus.subscribe<PkResumedEvent>(VIDEO_ROOM_PK_EVENTS.RESUMED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.RESUMED, e.payload),
    );

    this.bus.subscribe<PkEndedEvent>(VIDEO_ROOM_PK_EVENTS.ENDED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.ENDED, e.payload),
    );

    this.bus.subscribe<PkWinnerDeclaredEvent>(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, e.payload),
    );

    this.bus.subscribe<PkRewardDistributedEvent>(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, (e) => {
      const p = e.payload;
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, p);
      // A payout is told to the winner wherever they are, so it lands even if
      // they navigated away from the room — the VR-10/VR-11 gift/treasure
      // delivery precedent.
      for (const reward of p.rewards) {
        this.sockets.emitToUserEverywhere(reward.userId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, p);
      }
    });

    this.bus.subscribe<PkRecoveredEvent>(VIDEO_ROOM_PK_EVENTS.RECOVERED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.RECOVERED, e.payload),
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
