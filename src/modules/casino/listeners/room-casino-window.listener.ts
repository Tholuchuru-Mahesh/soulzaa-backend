/**
 * Audio-room casino window fan-out — the two things the window needs beyond
 * its lifecycle service:
 *
 *  1. ROOM-SCOPED SPECTATOR FEED. Subscribes `CASINO_ROUND_BROADCAST` (published
 *     by the leader-locked `CasinoLoopService` for EVERY global `/casino`
 *     broadcast) and re-emits the SAME event + payload verbatim into each
 *     active window session room on the `/games` namespace. Spectators join the
 *     window session room via `room:join` (admitted as `'spectator'` by
 *     `GamesRoomJoinPolicy` — an active room member of the window's roomId);
 *     they receive authoritative casino state/events with no second state
 *     machine, and a member of another room is denied at join so they never
 *     subscribe to the feed at all.
 *
 *  2. ROOM-END / ROOM-DELETE CLEANUP. On `AUDIO_ROOM_EVENTS.ENDED` and
 *     `AUDIO_ROOM_EVENTS.DELETED` closes the room's active casino window (a
 *     window carries no stake — nothing to refund). This is the casino
 *     module's own listener the board-game `AudioRoomLifecycleListener`
 *     deliberately defers casino codes to.
 *
 *  3. OWNERSHIP TRANSFER. On `AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED`
 *     re-points the active window's host to the new room owner (the new owner
 *     becomes the room's bettor).
 *
 * The orphan-window safety net for events that never fire (crash between
 * window-create and room-end, or a room torn down without the event reaching
 * us) lives in `RoomCasinoWindowMonitor`.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GameCode } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  AUDIO_ROOM_EVENTS,
  type RoomDeletedEvent,
  type RoomEndedEvent,
  type RoomForceLeaveEvent,
  type RoomLeftEvent,
  type RoomOwnershipTransferredEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GAMES_NAMESPACE } from 'src/modules/games/constants/games.constants';
import { GamesRepository } from 'src/modules/games/repositories/games.repository';
import {
  CASINO_ROUND_BROADCAST,
  CasinoRoundBroadcastEvent,
} from '../events/casino-round-broadcast.event';
import { RoomCasinoWindowService } from '../services/room-casino-window.service';

@Injectable()
export class RoomCasinoWindowListener implements OnModuleInit {
  private readonly logger = new Logger(RoomCasinoWindowListener.name);

  private static readonly CASINO_CODES: ReadonlySet<GameCode> = new Set([
    GameCode.GREEDY_FOOD,
    GameCode.LUCKY_FRUIT,
  ]);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly repo: GamesRepository,
    private readonly windows: RoomCasinoWindowService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<CasinoRoundBroadcastEvent>(CASINO_ROUND_BROADCAST, (e) => {
      void this.onRoundBroadcast(e).catch((err: Error) =>
        this.logger.error(`Casino room mirror failed: ${err.message}`),
      );
    });
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) => {
      void this.closeWindowForRoom(e.payload.roomId).catch((err: Error) =>
        this.logger.error(`Casino window room-end cleanup failed: ${err.message}`),
      );
    });
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) => {
      void this.closeWindowForRoom(e.payload.roomId).catch((err: Error) =>
        this.logger.error(`Casino window room-delete cleanup failed: ${err.message}`),
      );
    });
    // The HOST walking out ends the table. Without these two the window
    // outlived them: room END/DELETE were the only lifecycle hooks, and a room
    // whose host merely left is still live, so nothing closed the session and
    // every spectator kept watching a table nobody was playing.
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, (e) => {
      void this.windows
        .onHostLeft(e.payload.roomId, e.payload.userId)
        .catch((err: Error) =>
          this.logger.error(`Casino window host-left cleanup failed: ${err.message}`),
        );
    });
    this.bus.subscribe<RoomForceLeaveEvent>(AUDIO_ROOM_EVENTS.FORCE_LEAVE, (e) => {
      void this.windows
        .onHostLeft(e.payload.roomId, e.payload.userId)
        .catch((err: Error) =>
          this.logger.error(`Casino window host-force-leave cleanup failed: ${err.message}`),
        );
    });
    this.bus.subscribe<RoomOwnershipTransferredEvent>(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) => {
        void this.windows
          .onOwnerChanged(e.payload.roomId, e.payload.newOwnerId)
          .catch((err: Error) =>
            this.logger.error(`Casino window ownership transfer failed: ${err.message}`),
          );
      },
    );
  }

  /** Re-emit one global casino broadcast into every active window room for that game. */
  private async onRoundBroadcast(e: CasinoRoundBroadcastEvent): Promise<void> {
    const windows = await this.repo.listActiveRoomWindowsByCode(
      e.payload.game as unknown as GameCode,
    );
    for (const window of windows) {
      this.sockets.emitToNamespaceRoom(
        GAMES_NAMESPACE,
        window.id,
        e.payload.event,
        e.payload.payload,
      );
    }
  }

  /** Close the room's active casino window (if any) — used by the ENDED and DELETED paths. */
  private async closeWindowForRoom(roomId: string): Promise<void> {
    const session = await this.repo.findActiveSessionForRoom(roomId);
    if (!session || !RoomCasinoWindowListener.CASINO_CODES.has(session.code)) return;
    try {
      await this.windows.closeWindow(roomId, null);
    } catch (err) {
      // A concurrent manual close already moved the window out of ACTIVE —
      // closeWindow's fresh re-read throws on that, an expected race here.
      this.logger.warn(
        `Failed to close casino window for room ${roomId} on end: ${(err as Error).message}`,
      );
    }
  }
}
