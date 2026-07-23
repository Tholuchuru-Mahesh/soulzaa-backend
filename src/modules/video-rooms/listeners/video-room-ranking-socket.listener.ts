import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type DomainEvent, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { loadVideoRoomRankingConfig } from '../config/video-room-ranking.config';
import {
  DIMENSION_SOCKET_EVENT,
  VideoRoomRankingDimension,
  VIDEO_ROOM_RANKING_SOCKET_EVENTS,
  errorMessage,
} from '../constants/video-room-ranking.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_RANKING_EVENTS,
  type RankingMovementPayload,
} from '../events/video-room-ranking.events';
import { VideoRoomsMetrics } from '../video-rooms.metrics';

/** The most recent payload seen for one (room, dimension) inside a window. */
interface PendingBroadcast {
  event: string;
  payload: RankingMovementPayload;
}

/**
 * Bridges ranking movement to `/video-room` sockets — COALESCED.
 *
 * This is the one VR socket listener that must throttle. The treasure listener
 * deliberately does not, because its upstream already coalesces; ranking has no
 * such upstream. A single gift moves up to four dimensions, and a gift storm in
 * a busy room produces hundreds of movements a second. Emitting each one would
 * flood every client in the room with frames they cannot render, for a ladder
 * that visibly changes a few times a second at most.
 *
 * Only the LATEST payload per (room, dimension) survives a window — an
 * intermediate ranking state has no value once a newer one exists.
 */
@Injectable()
export class VideoRoomRankingSocketListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoRoomRankingSocketListener.name);
  private readonly windowMs: number;
  private readonly pending = new Map<string, PendingBroadcast>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly metrics: VideoRoomsMetrics,
  ) {
    this.windowMs = loadVideoRoomRankingConfig(config).coalesceWindowMs;
  }

  onModuleInit(): void {
    const subscribe = (busName: string, socketEvent: string) =>
      this.bus.subscribe<DomainEvent<RankingMovementPayload>>(busName, (e) =>
        this.enqueue(socketEvent, e.payload),
      );

    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.RANKING_UPDATED,
      VIDEO_ROOM_RANKING_SOCKET_EVENTS.RANKING_UPDATED,
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.LEADERBOARD_UPDATED,
      VIDEO_ROOM_RANKING_SOCKET_EVENTS.LEADERBOARD_UPDATED,
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.HOST_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.HOSTS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.GIFTER_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.GIFTERS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.ROOM_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.ROOMS],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.PK_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.PK],
    );
    subscribe(
      VIDEO_ROOM_RANKING_EVENTS.TREASURE_RANKING_UPDATED,
      DIMENSION_SOCKET_EVENT[VideoRoomRankingDimension.TREASURE],
    );
  }

  /** Clear timers so a shutdown or a test teardown leaves nothing pending. */
  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private enqueue(socketEvent: string, payload: RankingMovementPayload): void {
    // A global-scope movement has no room to broadcast into. Clients read those
    // over REST; pushing them would mean fanning out to every connected socket.
    if (!payload.roomId) return;

    const slot = `${payload.roomId}:${payload.dimension}`;
    this.pending.set(slot, { event: socketEvent, payload });

    if (this.timers.has(slot)) return; // window already open

    this.timers.set(
      slot,
      setTimeout(() => this.flush(slot), this.windowMs),
    );
  }

  private flush(slot: string): void {
    this.timers.delete(slot);
    const entry = this.pending.get(slot);
    this.pending.delete(slot);
    if (!entry) return;

    try {
      this.sockets.emitToNamespaceRoom(
        VIDEO_ROOM_NAMESPACE,
        entry.payload.roomId as string,
        entry.event,
        entry.payload,
      );
      // Counted only here, after the emit actually succeeded — not when
      // `enqueue` drops a no-roomId event, and not when the emit below
      // throws (the catch's job is to log that, not to also miscount it as
      // a delivered broadcast).
      this.metrics.incRankingBroadcast();
    } catch (err) {
      // Swallowed: this runs on a timer with no caller to receive a throw, and
      // an unhandled rejection here would take down the process.
      this.logger.warn(`ranking broadcast failed for ${slot}: ${errorMessage(err)}`);
    }
  }
}
