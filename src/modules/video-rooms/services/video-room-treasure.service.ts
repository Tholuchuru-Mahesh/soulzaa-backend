import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TreasureSession, TreasureSessionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import { loadVideoRoomTreasureConfig } from '../config/video-room-treasure.config';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { treasureLifecycleLockKey } from '../constants/video-room-treasure.constants';
import {
  TreasureClosedEvent,
  TreasureCreatedEvent,
  TreasureStartedEvent,
} from '../events/video-room-treasure.events';
import { TreasureBoxException } from '../exceptions/video-room-treasure.exceptions';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomTreasureRepository } from '../repositories/video-room-treasure.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomPermissionService } from './video-room-permission.service';
import type { TreasureLevelRules } from './video-room-treasure-pool.service';

/** States a room may hold before another ladder can be created. */
const LIVE = [
  TreasureSessionStatus.DRAFT,
  TreasureSessionStatus.ACTIVE,
  TreasureSessionStatus.PAUSED,
];

/**
 * The treasure lifecycle state machine (VR-11 spec §6.0).
 *
 *   DRAFT ──start──► ACTIVE ──(final level unlocks)──► COMPLETED
 *                     │  ▲                                  │
 *              pause  │  │ resume                           │
 *                     ▼  │                                  │
 *                   PAUSED                                  │
 *      any of the three ──close──► CLOSED ◄─────────────────┘
 *                                    └──archive──► ARCHIVED
 *
 * COMPLETED and CLOSED are deliberately distinct: COMPLETED means the ladder
 * ran to its end, CLOSED means an owner stopped it. Conflating them would make
 * "how many ladders actually finished?" unanswerable from the data.
 *
 * Every transition is a conditional UPDATE via `repo.transitionSession`, so two
 * concurrent owner commands are resolved by the database — exactly one gets a
 * non-null result and publishes its event. The per-room lock covers the
 * read-then-write in `create`, where the guard and the insert are separate
 * statements and a lock is the only thing serialising them.
 */
@Injectable()
export class VideoRoomTreasureService {
  constructor(
    private readonly repo: VideoRoomTreasureRepository,
    private readonly rooms: VideoRoomsRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async create(
    actor: RoomActor,
    roomId: string,
    dto: { poolOverride?: number } = {},
    requestId?: string,
  ): Promise<TreasureSession> {
    return this.locks.withLock(treasureLifecycleLockKey(roomId), async () => {
      await this.authorize(actor, roomId);
      await this.assertRoomAllowsTreasure(roomId);

      if (await this.repo.findCurrentSession(roomId)) {
        throw new TreasureBoxException(
          'This room already has a treasure ladder. Close it before creating another.',
        );
      }

      const levels = await this.repo.listEnabledLevels();
      if (levels.length === 0) {
        // A configuration fault, not a state conflict — the audio engine's
        // habit of reporting this as "a session is active" is what VR-11 avoids.
        throw new TreasureBoxException(
          'No treasure levels are configured.',
          HttpStatus.FAILED_DEPENDENCY,
        );
      }

      // Freeze the ladder now. Reading live config at unlock would let an admin
      // edit change the rules of a ladder players are already filling.
      const snapshot: TreasureLevelRules[] = levels.map((l) => ({
        level: l.level,
        threshold: Number(l.threshold),
        poolStrategy: dto.poolOverride !== undefined ? 'ADMIN_OVERRIDE' : l.poolStrategy,
        poolPercentBps: l.poolPercentBps,
        poolFixedAmount:
          dto.poolOverride ?? (l.poolFixedAmount !== null ? Number(l.poolFixedAmount) : null),
        winnerAlgorithm: l.winnerAlgorithm,
        winnerCount: l.winnerCount,
        minStaySeconds: l.minStaySeconds,
        minActivityEvents: l.minActivityEvents,
      }));

      const session = await this.repo.createSession({
        roomId,
        createdBy: actor.id,
        levelSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        boxes: levels.map((l) => ({ level: l.level, threshold: l.threshold })),
      });

      await this.bus.publish(
        new TreasureCreatedEvent({
          correlationId: randomUUID(),
          roomId,
          sessionId: session.id,
          createdBy: actor.id,
          levels: snapshot.map((l) => l.level),
          requestId,
        }),
      );
      return session;
    });
  }

  async start(actor: RoomActor, roomId: string, requestId?: string): Promise<TreasureSession> {
    return this.locks.withLock(treasureLifecycleLockKey(roomId), async () => {
      const current = await this.requireSession(actor, roomId);
      const session = await this.transition(
        current.id,
        [TreasureSessionStatus.DRAFT],
        TreasureSessionStatus.ACTIVE,
        'start a ladder that is not in draft',
      );

      // Boxes are created PENDING so a DRAFT ladder cannot absorb an in-flight
      // gift; starting is what promotes level 1 to ACTIVE.
      const boxes = await this.repo.listBoxes(session.id);
      const first = boxes.find((b) => b.level === session.currentLevel);
      if (first) await this.repo.activateBox(first.id);

      await this.bus.publish(
        new TreasureStartedEvent({
          correlationId: randomUUID(),
          roomId,
          sessionId: session.id,
          boxId: first?.id,
          level: session.currentLevel,
          startedBy: actor.id,
          threshold: Number(first?.threshold ?? 0n),
          requestId,
        }),
      );
      return session;
    });
  }

  async pause(actor: RoomActor, roomId: string, _requestId?: string): Promise<TreasureSession> {
    const current = await this.requireSession(actor, roomId);
    return this.transition(
      current.id,
      [TreasureSessionStatus.ACTIVE],
      TreasureSessionStatus.PAUSED,
      'pause a ladder that is not active',
    );
  }

  async resume(actor: RoomActor, roomId: string, _requestId?: string): Promise<TreasureSession> {
    const current = await this.requireSession(actor, roomId);
    return this.transition(
      current.id,
      [TreasureSessionStatus.PAUSED],
      TreasureSessionStatus.ACTIVE,
      'resume a ladder that is not paused',
    );
  }

  async close(actor: RoomActor, roomId: string, requestId?: string): Promise<TreasureSession> {
    const current = await this.requireSession(actor, roomId);
    const session = await this.transition(
      current.id,
      LIVE,
      TreasureSessionStatus.CLOSED,
      'close a ladder that has already ended',
    );
    await this.bus.publish(
      new TreasureClosedEvent({
        correlationId: randomUUID(),
        roomId,
        sessionId: session.id,
        status: TreasureSessionStatus.CLOSED,
        closedBy: actor.id,
        requestId,
      }),
    );
    return session;
  }

  /**
   * Archiving hides a finished ladder from the current-state read while leaving
   * it readable via history and winners — an owner can tidy the room without
   * destroying the payout record.
   */
  async archive(actor: RoomActor, roomId: string, _requestId?: string): Promise<TreasureSession> {
    await this.authorize(actor, roomId);
    if (await this.repo.findCurrentSession(roomId)) {
      throw new TreasureBoxException('Close the ladder before archiving it.');
    }
    const [sessions] = await this.repo.listSessions(roomId, 0, 1);
    const target = sessions[0];
    if (!target) {
      throw new TreasureBoxException('No treasure ladder to archive.', HttpStatus.NOT_FOUND);
    }
    return this.transition(
      target.id,
      [TreasureSessionStatus.COMPLETED, TreasureSessionStatus.CLOSED],
      TreasureSessionStatus.ARCHIVED,
      'archive a ladder that has not finished',
    );
  }

  // ---- internals ----

  private async authorize(actor: RoomActor, roomId: string): Promise<void> {
    if (!loadVideoRoomTreasureConfig(this.config).enabled) {
      throw new TreasureBoxException(
        'The treasure engine is disabled.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new TreasureBoxException('Room not found.', HttpStatus.NOT_FOUND);
    }
    await this.permissions.assertPermission(
      actor,
      { id: room.id, ownerId: room.ownerId },
      VideoRoomPermission.MANAGE_TREASURE,
    );
  }

  private async assertRoomAllowsTreasure(roomId: string): Promise<void> {
    const settings = await this.rooms.requireSettings(roomId);
    if (!settings.allowTreasure) {
      throw new TreasureBoxException(
        'Treasure boxes are disabled in this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async requireSession(actor: RoomActor, roomId: string): Promise<TreasureSession> {
    await this.authorize(actor, roomId);
    const session = await this.repo.findCurrentSession(roomId);
    if (!session) {
      throw new TreasureBoxException('No treasure ladder in this room.', HttpStatus.NOT_FOUND);
    }
    return session;
  }

  private async transition(
    sessionId: string,
    from: TreasureSessionStatus[],
    to: TreasureSessionStatus,
    failure: string,
  ): Promise<TreasureSession> {
    const session = await this.repo.transitionSession(sessionId, from, to);
    // null means this caller lost the conditional UPDATE — it must not also
    // publish an event for work another request actually did.
    if (!session) throw new TreasureBoxException(`Cannot ${failure}.`);
    return session;
  }
}
