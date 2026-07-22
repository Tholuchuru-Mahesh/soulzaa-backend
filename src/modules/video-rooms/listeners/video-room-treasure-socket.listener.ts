import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_TREASURE_SOCKET_EVENTS } from '../constants/video-room-treasure.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureProgressUpdatedEvent,
  type TreasureRecoveredEvent,
  type TreasureRewardDistributedEvent,
  type TreasureStartedEvent,
  type TreasureUnlockedEvent,
  type TreasureWinnerSelectedEvent,
} from '../events/video-room-treasure.events';

/**
 * Bridges treasure events to the `/video-room` sockets (VR-11). Follows the
 * VR-10 pattern: no domain gateway — inbound is the shared BaseGateway, outbound
 * is EVENT_BUS relayed here.
 *
 * Deliberately does NOT throttle. Coalescing already happened in `onSend`, the
 * only place that can distinguish a routine progress tick from a threshold
 * crossing. Re-throttling here could silently drop an unlock broadcast.
 */
@Injectable()
export class VideoRoomTreasureSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureStartedEvent>(VIDEO_ROOM_TREASURE_EVENTS.STARTED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.LEVEL_CHANGED, e.payload),
    );

    this.bus.subscribe<TreasureProgressUpdatedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.PROGRESS_UPDATED,
      (e) =>
        this.toRoom(
          e.payload.roomId,
          VIDEO_ROOM_TREASURE_SOCKET_EVENTS.PROGRESS_UPDATED,
          e.payload,
        ),
    );

    // REWARD_GENERATED is deliberately NOT bridged. It fires when the pool is
    // MINTED — before anyone has been paid — and carries {strategy, poolAmount},
    // not {userId, amount}. Relaying it as `treasureRewardDistributed` told
    // clients a payout had happened when none had, with a payload of the wrong
    // shape. The brief's socket vocabulary has no pool event, and
    // `treasureUnlocked` already reports `poolAmount`, so pool generation stays
    // an audit/metrics concern only.

    this.bus.subscribe<TreasureWinnerSelectedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.WINNER_SELECTED,
      (e) =>
        this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.WINNER_SELECTED, e.payload),
    );

    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => {
        this.toRoom(
          e.payload.roomId,
          VIDEO_ROOM_TREASURE_SOCKET_EVENTS.REWARD_DISTRIBUTED,
          e.payload,
        );
        // The winner is told wherever they are, so a payout lands even if they
        // have navigated away from the room — the VR-10 gift-delivery precedent.
        this.sockets.emitToUserEverywhere(
          e.payload.userId,
          VIDEO_ROOM_TREASURE_SOCKET_EVENTS.REWARD_DISTRIBUTED,
          e.payload,
        );
      },
    );

    this.bus.subscribe<TreasureUnlockedEvent>(VIDEO_ROOM_TREASURE_EVENTS.UNLOCKED, (e) => {
      const p = e.payload;
      this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.UNLOCKED, p);
      // A separate animation trigger so a client driving only visuals does not
      // have to parse the data payload.
      this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.ANIMATION, {
        correlationId: p.correlationId,
        roomId: p.roomId,
        boxId: p.boxId,
        level: p.level,
        poolAmount: p.poolAmount,
        winnerCount: p.winners.length,
      });
      // Only when a next box exists — a completed ladder has no level to move to.
      if (p.nextLevel !== null) {
        this.toRoom(p.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.LEVEL_CHANGED, {
          correlationId: p.correlationId,
          roomId: p.roomId,
          sessionId: p.sessionId,
          level: p.nextLevel,
        });
      }
    });

    this.bus.subscribe<TreasureRecoveredEvent>(VIDEO_ROOM_TREASURE_EVENTS.RECOVERED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_TREASURE_SOCKET_EVENTS.RECOVERED, e.payload),
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
