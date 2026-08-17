import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformRole, VideoRoom, VideoRoomLogAction, VideoRoomMemberRole } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { LockService } from 'src/infra/redis/lock.service';
import type { PublicIdentity } from 'src/modules/users/interfaces/profile.interface';
import { loadVideoRoomConfig, VideoRoomConfig } from '../config/video-room.config';
import {
  VIDEO_ROOM_DEFAULT_PAGE_SIZE,
  VIDEO_ROOM_MAX_PAGE_SIZE,
  videoRoomJoinLockKey,
} from '../constants/video-room.constants';
import type { VideoRoomDetailView } from '../entities/video-room-detail.view';
import type {
  VideoRoomMemberView,
  VideoRoomPresenceView,
  VideoRoomSessionView,
} from '../entities/video-room-member.view';
import { ConnectionType } from '../enums';
import type { RoomActor } from '../interfaces/room-actor.interface';
import type { VideoRoomSessionRecord } from '../interfaces/room-session-manager.interface';
import { toVideoRoomMemberView, toVideoRoomSessionView } from '../mappers/video-room-member.mapper';
import { VideoRoomEventsRepository } from '../repositories/video-room-events.repository';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from '../repositories/video-room-report.repository';
import { VideoRoomSeatsRepository } from '../repositories/video-room-seats.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsMetrics } from '../video-rooms.metrics';
import { derivePresenceState } from './video-room-presence-state';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomIdentityCache } from './video-room-identity-cache.service';
import { VideoRoomPasswordService } from './video-room-password.service';
import { VideoRoomPresenceService } from './video-room-presence.service';
import { VideoRoomQueryService } from './video-room-query.service';
import { VideoRoomSessionService } from './video-room-session.service';
import { VideoRoomStateService } from './video-room-state.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';

/** Client-supplied join fields (from JoinRoomDto) + server-derived context. */
export interface JoinContext {
  socketId: string;
  deviceId?: string;
  platform?: string;
  ip?: string;
  sid?: string;
}

/** Aggregate room counters surfaced in the sync payload (Redis-first). */
export interface RoomSyncCounts {
  members: number;
  viewers: number;
  online: number;
  reconnecting: number;
  idle: number;
  participants: number;
  activeConnections: number;
}

/** The full room-state sync returned by join / reconnect / GET sync. */
export interface RoomSyncPayload {
  room: VideoRoomDetailView;
  counts: RoomSyncCounts;
  members: VideoRoomMemberView[];
  presence: VideoRoomPresenceView[];
  announcements: unknown[];
  version: number;
}

/**
 * Orchestrates the video-room participant lifecycle (VR-3): join, leave,
 * reconnect, and room synchronisation. Composes the VR-0 managers
 * (state/session/presence) with the durable repositories; holds no Prisma or
 * Redis primitives of its own. The join write path runs under a per-room lock so
 * the capacity check and the member/session writes cannot be raced.
 */
@Injectable()
export class VideoRoomMemberService {
  private readonly logger = new Logger(VideoRoomMemberService.name);
  private readonly cfg: VideoRoomConfig;

  constructor(
    private readonly repo: VideoRoomsRepository,
    private readonly moderation: VideoRoomModerationRepository,
    private readonly passwords: VideoRoomPasswordService,
    private readonly state: VideoRoomStateService,
    private readonly sessions: VideoRoomSessionService,
    private readonly presence: VideoRoomPresenceService,
    private readonly events: VideoRoomEventService,
    private readonly eventsRepo: VideoRoomEventsRepository,
    private readonly query: VideoRoomQueryService,
    private readonly metrics: VideoRoomsMetrics,
    private readonly locks: LockService,
    config: ConfigService,
    private readonly seats: VideoRoomSeatsRepository,
    private readonly identities: VideoRoomIdentityCache,
    @Optional() private readonly performanceStats?: ModeratorPerformanceService,
    @Optional() private readonly investigationRecording?: InvestigationRecordingService,
    @Optional() private readonly reportRepo?: VideoRoomReportRepository,
  ) {
    this.cfg = loadVideoRoomConfig(config);
  }

  /**
   * Join a room. Validates (exists → live → block → password → capacity → dup),
   * writes the member + session + presence, bumps counters, publishes UserJoined
   * + SessionCreated, and returns the full room-state sync.
   */
  async join(
    actor: RoomActor,
    roomId: string,
    dto: { password?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    return this.locks.withLock(videoRoomJoinLockKey(roomId), async () => {
      const room = await this.repo.findById(roomId);
      if (!room)
        throw this.err(
          ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
          `Video room ${roomId} was not found.`,
          HttpStatus.NOT_FOUND,
        );
      if (room.status !== 'LIVE') {
        throw this.err(ERROR_CODES.VIDEO_ROOM_ENDED, 'This room is not live.', HttpStatus.CONFLICT);
      }

      const existing = await this.repo.getMember(roomId, actor.id);
      const alreadyMember = existing?.isActive ?? false;
      const isOwner = room.ownerId === actor.id;
      const privileged = isOwner || this.isPlatformAdmin(actor);

      if (!privileged) {
        if (await this.moderation.isActivelyBlocked(roomId, actor.id)) {
          throw this.err(
            ERROR_CODES.VIDEO_ROOM_BLOCKED,
            'You are blocked from this room.',
            HttpStatus.FORBIDDEN,
          );
        }
      }

      if (room.isLocked && room.passwordHash && !alreadyMember && !privileged) {
        const invited = await this.seats.hasActiveRoomInvitation(roomId, actor.id);
        if (!invited) {
          const ok = dto.password
            ? await this.passwords.verify(dto.password, room.passwordHash)
            : false;
          if (!ok) {
            throw this.err(
              ERROR_CODES.VIDEO_ROOM_PASSWORD_INVALID,
              'Incorrect room password.',
              HttpStatus.BAD_REQUEST,
            );
          }
        }
      }

      if (!alreadyMember) {
        const current = await this.presence.viewerCount(roomId);
        if (current >= room.maxViewers) {
          throw this.err(
            ERROR_CODES.VIDEO_ROOM_CAPACITY_EXCEEDED,
            'This room is full.',
            HttpStatus.CONFLICT,
          );
        }
      }

      // ---- Writes ----
      await this.presence.addViewer(roomId, actor.id);
      const role = isOwner ? VideoRoomMemberRole.OWNER : VideoRoomMemberRole.VIEWER;
      await this.repo.upsertActiveMember({
        roomId,
        userId: actor.id,
        role,
        deviceId: ctx.deviceId,
        platform: ctx.platform,
        actorId: actor.id,
      });
      await this.sessions.register({
        roomId,
        userId: actor.id,
        socketId: ctx.socketId,
        role: ConnectionType.SUBSCRIBER,
        deviceId: ctx.deviceId,
        platform: ctx.platform,
        ip: ctx.ip,
        sid: ctx.sid,
      });

      const liveCount = await this.presence.viewerCount(roomId);
      await this.state.applyUpdate(roomId, (cur) => ({
        status: room.status,
        isLocked: room.isLocked,
        viewerCount: liveCount,
        onlineCount: Math.max(0, liveCount - cur.reconnectingCount),
      }));
      await this.repo.bumpStatsOnJoin(roomId, liveCount);
      await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.JOINED });
      await this.audit(roomId, actor.id, 'member.joined', ctx);

      // RoomActor carries only { id, roles } — it is built from the access
      // token and has never had profile fields. Reading actor.username /
      // .name / .avatarUrl here did not compile AND emitted three undefineds,
      // which is why clients fell through to the literal string "User".
      // Resolve real identity from the same cache the roster uses.
      const joiner = (await this.identities.resolve([actor.id]).catch(() => null))?.get(actor.id);
      const isModerator = (actor.roles ?? []).some(
        (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
      );

      await this.events.emitUserJoined({
        roomId,
        userId: actor.id,
        username: isModerator ? undefined : joiner?.username,
        name: isModerator ? undefined : (joiner?.displayName ?? undefined),
        avatarUrl: isModerator ? undefined : (joiner?.avatarUrl ?? undefined),
        participantCount: liveCount,
      });
      await this.events.emitSessionCreated({ roomId, userId: actor.id, socketId: ctx.socketId });
      this.metrics.incJoin();
      this.metrics.setViewers(liveCount);

      if (isModerator) {
        if (this.performanceStats) {
          void this.performanceStats.recordAction(actor.id, 'ROOM_VISITED');
        }
        if (this.investigationRecording && this.reportRepo) {
          // Matches the spec's "Report Received → Moderator reviews report →
          // Joins assigned room → Backend automatically starts secure
          // investigation recording" flow: recording opens per pending report
          // (not a blanket per-join recording against the room owner), with no
          // reason yet — `completeRecording` finalizes it once the moderator's
          // action determines one. `beginOrReuseRecording` so a reconnect or
          // re-join doesn't stack duplicate recordings for the same report.
          void this.reportRepo.listPendingReports(roomId).then((reports) =>
            Promise.all(
              reports.map((report) =>
                this.investigationRecording!.beginOrReuseRecording({
                  moderatorId: actor.id,
                  targetUserId: report.targetUserId,
                  roomId,
                  evidencePayload: { roomId, reportId: report.id, trigger: 'room_join' },
                }),
              ),
            ),
          );
        }
      }

      return this.buildSyncPayload(room, roomId);
    });
  }

  /**
   * Leave a room (graceful exit). Removes presence, ends the socket session(s),
   * deactivates the member, decrements counters, publishes UserLeft.
   */
  async leave(
    actor: RoomActor,
    roomId: string,
    dto: { socketId?: string },
    ctx?: { ip?: string },
  ): Promise<void> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw this.err(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    await this.presence.removeViewer(roomId, actor.id);
    const ended = dto.socketId
      ? [await this.sessions.end(dto.socketId)].filter(
          (r): r is VideoRoomSessionRecord => r !== null,
        )
      : await this.sessions.endUserRoomSessions(roomId, actor.id);
    await this.repo.deactivateMember(roomId, actor.id, actor.id);

    const liveCount = await this.presence.viewerCount(roomId);
    await this.state.applyUpdate(roomId, (cur) => ({
      viewerCount: liveCount,
      onlineCount: Math.max(0, liveCount - cur.reconnectingCount),
    }));
    await this.repo.bumpStatsOnLeave(roomId, liveCount);
    await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.LEFT });
    await this.audit(roomId, actor.id, 'member.left', {
      socketId: dto.socketId ?? '',
      ip: ctx?.ip,
    });

    await this.events.emitUserLeft({ roomId, userId: actor.id, participantCount: liveCount });
    this.metrics.incLeave();
    this.metrics.setViewers(liveCount);
    for (const record of ended) {
      this.metrics.observeSessionDuration(this.durationSeconds(record));
    }
  }

  /**
   * Reconnect within the grace window. The member must still be ACTIVE (else the
   * session was already reclaimed → RECONNECT_FAILED). Re-registers the new socket,
   * restores ONLINE presence, decrements the reconnecting counter, publishes
   * UserReconnected, and returns a fresh sync.
   */
  async reconnect(
    actor: RoomActor,
    roomId: string,
    dto: { previousSocketId?: string },
    ctx: JoinContext,
  ): Promise<RoomSyncPayload> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw this.err(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (room.status !== 'LIVE') {
      throw this.err(ERROR_CODES.VIDEO_ROOM_ENDED, 'This room is not live.', HttpStatus.CONFLICT);
    }
    const member = await this.repo.getMember(roomId, actor.id);
    if (!member?.isActive) {
      throw this.err(
        ERROR_CODES.VIDEO_ROOM_RECONNECT_FAILED,
        'Your session was already reclaimed — rejoin the room.',
        HttpStatus.CONFLICT,
      );
    }

    await this.sessions.register({
      roomId,
      userId: actor.id,
      socketId: ctx.socketId,
      role: ConnectionType.SUBSCRIBER,
      deviceId: ctx.deviceId,
      platform: ctx.platform,
      ip: ctx.ip,
      sid: ctx.sid,
    });
    await this.sessions.touchReconnect(ctx.socketId, dto.previousSocketId);
    await this.presence.addViewer(roomId, actor.id);

    const liveCount = await this.presence.viewerCount(roomId);
    await this.state.applyUpdate(roomId, (cur) => {
      const reconnecting = Math.max(0, cur.reconnectingCount - 1);
      return {
        viewerCount: liveCount,
        reconnectingCount: reconnecting,
        onlineCount: Math.max(0, liveCount - reconnecting),
      };
    });
    await this.audit(roomId, actor.id, 'member.reconnected', ctx);
    await this.events.emitUserReconnected({ roomId, userId: actor.id, socketId: ctx.socketId });
    this.metrics.incReconnect();

    return this.buildSyncPayload(room, roomId);
  }

  /** Explicit room synchronisation (version-based). Publishes RoomSynchronized. */
  async sync(_actor: RoomActor, roomId: string, _lastVersion?: number): Promise<RoomSyncPayload> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw this.err(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    const payload = await this.buildSyncPayload(room, roomId);
    await this.events.emitRoomSynchronized({ roomId, version: payload.version });
    return payload;
  }

  /** A page of active members (roster). Also the Flutter client's identity-cache warm source. */
  async listMembers(
    roomId: string,
    take: number,
    skip: number,
  ): Promise<{ items: VideoRoomMemberView[]; total: number }> {
    const rows = await this.repo.listActiveMembers(roomId, take, skip);
    const total = await this.repo.countActiveMembers(roomId);

    // Display-only: never fail the roster because identity lookup did.
    let identities = new Map<string, PublicIdentity>();
    let identitiesResolved = false;
    try {
      identities = await this.identities.resolve(rows.map((r) => r.userId));
      identitiesResolved = true;
    } catch (err) {
      this.logger.warn(`Member identity enrichment failed for room ${roomId}: ${String(err)}`);
    }

    // Hidden staff accounts (e.g. anonymous Moderators) are absent from
    // `identities` by design when resolution succeeds — drop their roster
    // row entirely rather than returning one with every field blanked
    // (mirrors listPresence below). When resolution itself failed, keep
    // every row rather than emptying the roster for everyone.
    const visibleRows = identitiesResolved
      ? rows.filter((r) => identities.has(r.userId))
      : rows;

    return {
      items: visibleRows.map((r) => ({ ...toVideoRoomMemberView(r), user: identities.get(r.userId) })),
      total,
    };
  }

  /** Live presence for the room's active members (derived per member, excluding hidden staff accounts). */
  async listPresence(roomId: string): Promise<VideoRoomPresenceView[]> {
    const rows = await this.repo.listActiveMembers(roomId, VIDEO_ROOM_MAX_PAGE_SIZE, 0);
    const identities = await this.identities.resolve(rows.map((m) => m.userId));
    const visibleUserIds = rows.map((m) => m.userId).filter((id) => identities.has(id));
    return this.buildPresencePage(roomId, visibleUserIds);
  }

  /** The caller's own live session in a room, or null. */
  async getMySession(userId: string, roomId: string): Promise<VideoRoomSessionView | null> {
    const record = await this.findUserRoomSession(roomId, userId);
    return record ? toVideoRoomSessionView(record) : null;
  }

  /**
   * Member-level teardown for a session the monitor reclaimed after the grace
   * window (the Redis/DB session records are already gone). Deactivates the member
   * when they hold no other live session in the room, decrements counters, and
   * publishes HeartbeatMissed + UserLeft(timeout) + SessionExpired.
   */
  async reclaim(row: {
    roomId: string;
    userId: string;
    socketId: string | null;
    joinedAt: Date;
  }): Promise<void> {
    await this.events.emitHeartbeatMissed({
      roomId: row.roomId,
      userId: row.userId,
      socketId: row.socketId ?? '',
    });

    const stillLive = await this.findUserRoomSession(row.roomId, row.userId);
    if (!stillLive) {
      await this.presence.removeViewer(row.roomId, row.userId);
      await this.repo.deactivateMember(row.roomId, row.userId, row.userId);
    }

    const liveCount = await this.presence.viewerCount(row.roomId);
    await this.state.applyUpdate(row.roomId, (cur) => {
      const reconnecting = Math.max(0, cur.reconnectingCount - 1);
      return {
        viewerCount: liveCount,
        reconnectingCount: reconnecting,
        onlineCount: Math.max(0, liveCount - reconnecting),
      };
    });
    await this.repo.bumpStatsOnLeave(row.roomId, liveCount);

    const durationSeconds = Math.max(0, Math.round((Date.now() - row.joinedAt.getTime()) / 1000));
    await this.eventsRepo.appendEvent({
      roomId: row.roomId,
      actorId: row.userId,
      eventType: 'session.expired',
      payload: { userId: row.userId, socketId: row.socketId ?? null, durationSeconds },
    });
    await this.events.emitUserLeft({
      roomId: row.roomId,
      userId: row.userId,
      participantCount: liveCount,
    });
    await this.events.emitSessionExpired({
      roomId: row.roomId,
      userId: row.userId,
      socketId: row.socketId ?? '',
      durationSeconds,
    });
    this.metrics.incLeave();
    this.metrics.observeSessionDuration(durationSeconds);
  }

  private durationSeconds(record: VideoRoomSessionRecord): number {
    return Math.max(0, Math.round((Date.now() - Date.parse(record.connectedAt)) / 1000));
  }

  // ---- Shared read/build helpers (used by join, reconnect, sync) ----

  /** Assemble the version-based room-state sync payload (bounded member/presence page). */
  protected async buildSyncPayload(room: VideoRoom, roomId: string): Promise<RoomSyncPayload> {
    const detail = await this.query.getDetail(roomId);
    const snapshot = (await this.state.getSnapshot(roomId)) ?? (await this.state.restore(roomId));
    const version = snapshot?.version ?? 0;
    const memberRows = await this.repo.listActiveMembers(roomId, VIDEO_ROOM_DEFAULT_PAGE_SIZE, 0);
    const members = memberRows.map(toVideoRoomMemberView);
    const presence = await this.buildPresencePage(
      roomId,
      memberRows.map((m) => m.userId),
    );
    const announcements = await this.eventsRepo.listAnnouncements(roomId);
    const counts: RoomSyncCounts = {
      members: await this.repo.countActiveMembers(roomId),
      viewers: snapshot?.viewerCount ?? 0,
      online: snapshot?.onlineCount ?? 0,
      reconnecting: snapshot?.reconnectingCount ?? 0,
      idle: snapshot?.idleCount ?? 0,
      participants: snapshot?.participantCount ?? 0,
      activeConnections: await this.sessions.roomSessionCount(roomId),
    };
    return { room: detail, counts, members, presence, announcements, version };
  }

  /** Derive each listed member's live presence from their session in this room. */
  protected async buildPresencePage(
    roomId: string,
    userIds: string[],
  ): Promise<VideoRoomPresenceView[]> {
    const now = Date.now();
    const out: VideoRoomPresenceView[] = [];
    for (const userId of userIds) {
      const record = await this.findUserRoomSession(roomId, userId);
      const state = derivePresenceState(record, now, this.cfg);
      out.push({
        userId,
        state,
        socketId: record?.socketId ?? null,
        lastSeenAt: record?.lastSeenAt ?? null,
      });
    }
    return out;
  }

  /** The user's live session record in this room (via the per-user reverse index), or null. */
  protected async findUserRoomSession(
    roomId: string,
    userId: string,
  ): Promise<VideoRoomSessionRecord | null> {
    const socketIds = await this.sessions.listUserSessions(userId);
    for (const socketId of socketIds) {
      const record = await this.sessions.getSession(socketId);
      if (record?.roomId === roomId) return record;
    }
    return null;
  }

  /** Record a rich audit row (userId, socketId, sid, deviceId, ip, platform) to the event store. */
  protected audit(
    roomId: string,
    userId: string,
    eventType: string,
    ctx: JoinContext,
  ): Promise<void> {
    return this.eventsRepo.appendEvent({
      roomId,
      actorId: userId,
      eventType,
      payload: {
        userId,
        socketId: ctx.socketId,
        deviceId: ctx.deviceId ?? null,
        platform: ctx.platform ?? null,
        ip: ctx.ip ?? null,
        sid: ctx.sid ?? null,
      },
      correlationId: ctx.sid ?? ctx.socketId,
    });
  }

  protected isPlatformAdmin(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) ||
      actor.roles.includes(PlatformRole.SUPER_ADMIN) ||
      actor.roles.includes(PlatformRole.MODERATOR)
    );
  }

  protected err(
    code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
    message: string,
    status: HttpStatus,
  ): BusinessException {
    return new BusinessException(code, message, status);
  }
}
