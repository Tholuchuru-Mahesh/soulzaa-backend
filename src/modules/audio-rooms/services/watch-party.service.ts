import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RoomMemberRole, RoomWatchParty, WatchPartyStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { watchPartyLockKey } from '../constants/premium.constants';
import { WatchPartyUpdatedEvent } from '../events/audio-room-premium.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { WatchPartyRepository } from '../repositories/watch-party.repository';
import { RoomPermissionService } from './room-permission.service';

const MANAGER_ROLES: ReadonlySet<RoomMemberRole> = new Set([
  RoomMemberRole.OWNER,
  RoomMemberRole.ADMIN,
  RoomMemberRole.PREMIUM_ADMIN,
]);

/** YouTube video id (11 chars). */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * YouTube watch party (AR-9): the room owner/admin sets a video and controls
 * play/pause/seek/stop; the state is persisted and broadcast so every client
 * stays in sync. A late joiner reads `getState`, which returns the drift-
 * corrected effective position (base + elapsed while PLAYING).
 */
@Injectable()
export class WatchPartyService {
  constructor(
    private readonly repo: WatchPartyRepository,
    private readonly permissions: RoomPermissionService,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async getState(roomId: string): Promise<unknown> {
    const row = await this.repo.get(roomId);
    return this.toView(roomId, row);
  }

  async setVideo(actor: RoomActor, roomId: string, videoId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    if (!VIDEO_ID_RE.test(videoId)) {
      throw new BusinessException(
        ERROR_CODES.INVALID_VIDEO_ID,
        'Invalid YouTube video id.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.write(roomId, actor.id, {
      videoId,
      status: WatchPartyStatus.PLAYING,
      positionSeconds: 0,
    });
  }

  async play(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const row = await this.requireVideo(roomId);
    return this.write(roomId, actor.id, {
      videoId: row.videoId,
      status: WatchPartyStatus.PLAYING,
      positionSeconds: row.positionSeconds,
    });
  }

  async pause(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const row = await this.requireVideo(roomId);
    // Freeze at the current effective position.
    return this.write(roomId, actor.id, {
      videoId: row.videoId,
      status: WatchPartyStatus.PAUSED,
      positionSeconds: this.effectivePosition(row),
    });
  }

  async seek(actor: RoomActor, roomId: string, positionSeconds: number): Promise<unknown> {
    await this.assertManager(roomId, actor);
    const row = await this.requireVideo(roomId);
    return this.write(roomId, actor.id, {
      videoId: row.videoId,
      status: row.status,
      positionSeconds: Math.max(0, Math.floor(positionSeconds)),
    });
  }

  async stop(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.assertManager(roomId, actor);
    return this.write(roomId, actor.id, {
      videoId: null,
      status: WatchPartyStatus.STOPPED,
      positionSeconds: 0,
    });
  }

  // ---- Internals ----

  private async write(
    roomId: string,
    controlledBy: string,
    data: { videoId: string | null; status: WatchPartyStatus; positionSeconds: number },
  ): Promise<unknown> {
    return this.locks.withLock(watchPartyLockKey(roomId), async () => {
      const row = await this.repo.upsert(roomId, { ...data, controlledBy });
      await this.bus.publish(
        new WatchPartyUpdatedEvent({
          roomId,
          videoId: row.videoId,
          status: row.status,
          positionSeconds: row.positionSeconds,
          controlledBy: row.controlledBy,
        }),
      );
      return this.toView(roomId, row);
    });
  }

  private async requireVideo(roomId: string): Promise<RoomWatchParty> {
    const row = await this.repo.get(roomId);
    if (!row || !row.videoId || row.status === WatchPartyStatus.STOPPED) {
      throw new BusinessException(
        ERROR_CODES.WATCH_PARTY_INACTIVE,
        'No watch party is active in this room.',
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private effectivePosition(row: RoomWatchParty): number {
    if (row.status !== WatchPartyStatus.PLAYING) return row.positionSeconds;
    const elapsed = Math.floor((Date.now() - row.updatedAt.getTime()) / 1000);
    return row.positionSeconds + Math.max(0, elapsed);
  }

  private async assertManager(roomId: string, actor: RoomActor): Promise<void> {
    const role = await this.permissions.getEffectiveRole(roomId, actor.id);
    if (!role || !MANAGER_ROLES.has(role)) {
      throw new BusinessException(
        ERROR_CODES.WATCH_PARTY_NOT_AUTHORIZED,
        'Only the room owner or an admin can control the watch party.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private toView(roomId: string, row: RoomWatchParty | null) {
    if (!row) {
      return { roomId, videoId: null, status: WatchPartyStatus.STOPPED, positionSeconds: 0 };
    }
    return {
      roomId,
      videoId: row.videoId,
      status: row.status,
      positionSeconds: this.effectivePosition(row),
      controlledBy: row.controlledBy,
    };
  }
}
