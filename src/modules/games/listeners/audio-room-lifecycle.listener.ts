import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GameCode, GameSessionStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomEndedEvent,
  type RoomOwnershipTransferredEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GamesRepository } from '../repositories/games.repository';
import { GamesService } from '../services/games.service';

/**
 * Reacts to an audio room ending while it has an active, room-bound board-game
 * session (Ludo/Carrom) — reuses the existing `abortSession` refund path
 * verbatim (per the "do not invent new settlement rules" rule): every
 * still-unresolved stake is refunded exactly as it would be for any other
 * server-initiated abort. A no-op when the room had no active session, or
 * when its active session is a casino room-window (GREEDY_FOOD/LUCKY_FRUIT —
 * those carry no stake to refund and are handled by the casino module's own
 * listener on the same event, `RoomCasinoWindowService`).
 */
@Injectable()
export class AudioRoomLifecycleListener implements OnModuleInit {
  private readonly logger = new Logger(AudioRoomLifecycleListener.name);

  private static readonly CASINO_CODES: ReadonlySet<GameCode> = new Set([
    GameCode.GREEDY_FOOD,
    GameCode.LUCKY_FRUIT,
  ]);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly repo: GamesRepository,
    private readonly games: GamesService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) => {
      void this.onRoomEnded(e.payload.roomId);
    });
    this.bus.subscribe<RoomOwnershipTransferredEvent>(
      AUDIO_ROOM_EVENTS.OWNERSHIP_TRANSFERRED,
      (e) => {
        void this.onRoomOwnershipTransferred(e.payload.roomId, e.payload.newOwnerId);
      },
    );
  }

  private async onRoomEnded(roomId: string): Promise<void> {
    const session = await this.repo.findActiveSessionForRoom(roomId);
    if (session && !AudioRoomLifecycleListener.CASINO_CODES.has(session.code)) {
      try {
        await this.games.abortSession(session.id, GameSessionStatus.ABORTED, null, 'room_ended');
      } catch (err) {
        // A concurrent settle/forfeit/cancel already moved the session out of
        // ACTIVE — abortSession's own fresh re-check throws on that, which is
        // an expected race here, not a failure to log loudly.
        this.logger.warn(
          `Failed to abort room-bound session ${session.id} on room end: ${(err as Error).message}`,
        );
      }
    }
    try {
      await this.games.closeRoomBoundLobby(roomId);
    } catch (err) {
      this.logger.warn(
        `Failed to close room-bound lobby for room ${roomId} on room end: ${(err as Error).message}`,
      );
    }
  }

  /**
   * A room's ownership transferred — the new owner becomes the host of any
   * room-bound board-game lobby (so they can start it) and active session (so
   * they can report/cancel it). Casino windows are re-hosted by the casino
   * module's own listener; `repointRoomGameHost` skips those codes.
   */
  private async onRoomOwnershipTransferred(roomId: string, newOwnerId: string): Promise<void> {
    try {
      await this.games.repointRoomGameHost(roomId, newOwnerId);
    } catch (err) {
      this.logger.warn(
        `Failed to re-point room-bound board game for room ${roomId} on ownership transfer: ${(err as Error).message}`,
      );
    }
  }
}
