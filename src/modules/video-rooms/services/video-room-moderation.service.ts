import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  PlatformRole,
  VideoRoomChatMode,
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomReportReason,
  VideoRoomSettings,
} from '@prisma/client';
import type { Queue } from 'bullmq';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { LockService } from 'src/infra/redis/lock.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  moderationLockKey,
  SYSTEM_MODERATOR_ID,
  VIDEO_ROOM_MODERATION_QUEUES,
} from '../constants/video-room-moderation.constants';
import {
  ELEVATED_VIDEO_ROOM_ROLES,
  VideoRoomPermission,
} from '../constants/video-room-permissions';
import type { MuteChannel, MuteVideoRoomUserDto } from '../dto/moderation.dto';
import {
  BlacklistException,
  KickException,
  ModerationException,
  MuteException,
  OwnerProtectionException,
} from '../exceptions/video-room-moderation.exceptions';
import { ChatModeChangedEvent } from '../events/video-room-chat.events';
import {
  RoomModerationUpdatedEvent,
  UserBlacklistedEvent,
  UserForceDisconnectedEvent,
  UserKickedEvent,
  UserMutedEvent,
  UserUnblacklistedEvent,
  UserUnmutedEvent,
  UserWarnedEvent,
} from '../events/video-room-moderation.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationMetrics } from '../metrics/video-room-moderation.metrics';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomWarningRepository } from '../repositories/video-room-warning.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomMediaService } from './video-room-media.service';
import { VideoRoomReportService } from './video-room-report.service';
import { VideoRoomSessionService } from './video-room-session.service';
import {
  VideoRoomPermissionService,
  type PermissionRoomRef,
} from './video-room-permission.service';

/** Omitting `channels` on mute/unmute/muteAll/unmuteAll means "both" — see `MuteChannel`. */
const DEFAULT_MUTE_CHANNELS: MuteChannel[] = ['chat', 'mic'];

/** The outcome of a bulk kick: who was ejected, and who was skipped and why. */
export interface KickManyResult {
  kicked: string[];
  skipped: { userId: string; reason: string }[];
}

/**
 * Phase 16 moderation engine: kick, blacklist (durable bar-from-room), mute,
 * warn, report and the automated-moderation escalations. Every targeted action
 * runs the same prereq chain (not-self → permission → owner-protection →
 * outranks, platform ADMIN/SUPER_ADMIN exempt) before any write, mirrors the
 * Audio Room `ModerationService` kick pipeline, but a Video Room kick is a
 * HARD eject: deactivate membership + force-disconnect every socket the user
 * holds **in this room's namespace** (`disconnectUserInNamespace`, not
 * `disconnectUserEverywhere` — a kick from one video room must not drop the
 * target's DM/call/audio-room/other-video-room sockets) — there is no ban
 * table (`VideoRoomBlock`/"blacklist" is the only durable bar-from-room
 * primitive; see `video-room-permissions.ts`'s module doc).
 */
@Injectable()
export class VideoRoomModerationService {
  constructor(
    private readonly rooms: VideoRoomsRepository,
    private readonly moderationRepo: VideoRoomModerationRepository,
    private readonly permissions: VideoRoomPermissionService,
    private readonly session: VideoRoomSessionService,
    private readonly sockets: SocketManager,
    private readonly locks: LockService,
    private readonly metrics: VideoRoomModerationMetrics,
    @InjectQueue(VIDEO_ROOM_MODERATION_QUEUES.PROCESSING) private readonly queue: Queue,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly media: VideoRoomMediaService,
    private readonly warningRepo: VideoRoomWarningRepository,
    private readonly reportService: VideoRoomReportService,
    private readonly config: ConfigService,
  ) {}

  // ======================= Kick =======================

  /**
   * Eject a member now: deactivate their membership and force-disconnect every
   * socket they hold (no ban — they may attempt to rejoin unless also
   * blacklisted). Runs under the per-room moderation lock so a concurrent
   * kick/blacklist of the same target can't race the membership write.
   */
  async kick(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason?: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.assertPrereqs(
      roomId,
      actor,
      targetUserId,
      VideoRoomPermission.KICK_USERS,
    );

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      const member = await this.rooms.getMember(ref.id, targetUserId);
      if (!member?.isActive) {
        throw new KickException(
          ERROR_CODES.VIDEO_ROOM_NOT_MEMBER,
          'That user is not an active member of this room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      await this.ejectFromRoom(ref.id, targetUserId, actor.id);
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action: VideoRoomModerationActionType.KICK,
        reason: reason ?? null,
        metadata: this.auditMetadata(undefined, requestMeta),
      });
    });

    await this.bus.publish(
      new UserKickedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        reason: reason ?? null,
      }),
    );
    this.metrics.incKick();
    await this.notifyUser(targetUserId, 'video_room.kicked', {
      roomId: ref.id,
      reason: reason ?? null,
    });
  }

  /**
   * Kick every target, continuing past individual failures (e.g. a target who
   * outranks the actor) so one bad id doesn't abort the whole batch. Each
   * target runs the full `kick` pipeline (prereqs, lock, audit, publish)
   * independently.
   */
  async kickMany(
    actor: RoomActor,
    roomId: string,
    targetUserIds: string[],
    reason?: string,
    requestMeta?: RequestMetadata,
  ): Promise<KickManyResult> {
    const kicked: string[] = [];
    const skipped: { userId: string; reason: string }[] = [];

    for (const targetUserId of targetUserIds) {
      try {
        await this.kick(actor, roomId, targetUserId, reason, requestMeta);
        kicked.push(targetUserId);
      } catch (err) {
        skipped.push({ userId: targetUserId, reason: this.errorMessage(err) });
      }
    }
    return { kicked, skipped };
  }

  // ======================= Blacklist / unblacklist =======================

  /**
   * Durably bar a user from the room. If they are currently in the room, they
   * are also ejected now (blacklisting always implies an immediate kick).
   * Idempotency: a second blacklist attempt while one is ACTIVE is refused
   * rather than stacked.
   */
  async blacklist(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason?: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.assertPrereqs(
      roomId,
      actor,
      targetUserId,
      VideoRoomPermission.BLOCK_USERS,
    );

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      const existing = await this.moderationRepo.findActiveBlock(ref.id, targetUserId);
      if (existing) {
        throw new BlacklistException(
          ERROR_CODES.VIDEO_ROOM_ALREADY_BLOCKED,
          'That user is already blacklisted from this room.',
          HttpStatus.CONFLICT,
        );
      }
      const block = await this.moderationRepo.createBlock({
        roomId: ref.id,
        userId: targetUserId,
        moderatorId: actor.id,
        reason: reason ?? null,
      });
      await this.moderationRepo.addBlockMirror(ref.id, targetUserId);

      const member = await this.rooms.getMember(ref.id, targetUserId);
      if (member?.isActive) {
        await this.ejectFromRoom(ref.id, targetUserId, actor.id);
      }

      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action: VideoRoomModerationActionType.BLOCK,
        reason: reason ?? null,
        metadata: this.auditMetadata({ blockId: block.id }, requestMeta),
      });
    });

    await this.bus.publish(
      new UserBlacklistedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        reason: reason ?? null,
      }),
    );
    this.metrics.incBlacklist();
    await this.notifyUser(targetUserId, 'video_room.blacklisted', {
      roomId: ref.id,
      reason: reason ?? null,
    });
  }

  /**
   * Restore a blacklisted user: lift their ACTIVE block so they may rejoin.
   * Restorative, like the audio room's unban/unmute — only requires
   * `BLOCK_USERS`, no self-check, no outranks check (the target holds no
   * in-room role to outrank once barred).
   */
  async unblacklist(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.BLOCK_USERS);

    const block = await this.moderationRepo.findActiveBlock(ref.id, targetUserId);
    if (!block) {
      throw new BlacklistException(
        ERROR_CODES.VIDEO_ROOM_BLOCK_NOT_FOUND,
        'No active blacklist entry found for that user.',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.moderationRepo.liftBlock(block.id, actor.id);
    await this.moderationRepo.removeBlockMirror(ref.id, targetUserId);
    await this.moderationRepo.appendAction({
      roomId: ref.id,
      moderatorId: actor.id,
      targetUserId,
      action: VideoRoomModerationActionType.UNBLOCK,
      metadata: this.auditMetadata({ blockId: block.id }, requestMeta),
    });

    await this.bus.publish(
      new UserUnblacklistedEvent({ roomId: ref.id, moderatorId: actor.id, targetUserId }),
    );
  }

  // ======================= Mute / unmute / muteAll =======================

  /**
   * Mute a member on one or both independently-scoped channels (default:
   * both). `chat` is a durable `VideoRoomMute` row (dup-guarded — one ACTIVE
   * mute per room/user) mirrored into Redis for the fast chat-gate read.
   * `mic` delegates entirely to the existing media force-mute pipeline (no
   * new mic-mute system). One audit row covers whichever channels were
   * touched; `metrics.incMute` fires once per channel actually muted.
   */
  async mute(
    actor: RoomActor,
    roomId: string,
    dto: MuteVideoRoomUserDto,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const targetUserId = dto.userId;
    const channels = dto.channels ?? DEFAULT_MUTE_CHANNELS;
    const ref = await this.assertPrereqs(
      roomId,
      actor,
      targetUserId,
      VideoRoomPermission.MUTE_USERS,
    );
    const expiresAt = this.resolveExpiry(channels, dto.type, dto.durationMinutes);

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      if (channels.includes('chat')) {
        const existing = await this.moderationRepo.findActiveMute(ref.id, targetUserId);
        if (existing) {
          throw new MuteException(
            ERROR_CODES.VIDEO_ROOM_ALREADY_MUTED,
            'That user is already muted in this room.',
            HttpStatus.CONFLICT,
          );
        }
        await this.moderationRepo.createMute({
          roomId: ref.id,
          userId: targetUserId,
          moderatorId: actor.id,
          type: dto.type,
          reason: dto.reason ?? null,
          expiresAt,
        });
        await this.moderationRepo.addMuteMirror(
          ref.id,
          targetUserId,
          expiresAt ? expiresAt.getTime() - Date.now() : null,
        );
      }
      if (channels.includes('mic')) {
        await this.media.forceMute(actor, ref.id, { targetUserId, muted: true });
      }
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action:
          dto.type === VideoRoomModerationMuteType.PERMANENT
            ? VideoRoomModerationActionType.MUTE_PERMANENT
            : VideoRoomModerationActionType.MUTE_TEMPORARY,
        reason: dto.reason ?? null,
        metadata: this.auditMetadata(
          { channels, expiresAt: expiresAt?.toISOString() ?? null },
          requestMeta,
        ),
      });
    });

    await this.bus.publish(
      new UserMutedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        type: dto.type,
        reason: dto.reason ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        channels,
      }),
    );
    for (const channel of channels) {
      this.metrics.incMute(channel);
    }
    await this.notifyUser(targetUserId, 'video_room.muted', {
      roomId: ref.id,
      type: dto.type,
      channels,
      reason: dto.reason ?? null,
    });
  }

  /**
   * Reverse a mute per channel (default: both). Restorative, like
   * `unblacklist` — perm-only, no self-check/owner-protection/outranks (the
   * target's rank doesn't change what a moderator may lift).
   */
  async unmute(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    channels?: MuteChannel[],
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const chans = channels ?? DEFAULT_MUTE_CHANNELS;
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.MUTE_USERS);

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      if (chans.includes('chat')) {
        const mute = await this.moderationRepo.findActiveMute(ref.id, targetUserId);
        if (!mute) {
          throw new MuteException(
            ERROR_CODES.VIDEO_ROOM_MUTE_NOT_FOUND,
            'No active mute found for that user.',
            HttpStatus.NOT_FOUND,
          );
        }
        await this.moderationRepo.liftMute(mute.id, actor.id);
        await this.moderationRepo.removeMuteMirror(ref.id, targetUserId);
      }
      if (chans.includes('mic')) {
        await this.media.forceMute(actor, ref.id, { targetUserId, muted: false });
      }
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action: VideoRoomModerationActionType.UNMUTE,
        metadata: this.auditMetadata({ channels: chans }, requestMeta),
      });
    });

    await this.bus.publish(
      new UserUnmutedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        channels: chans,
        reason: 'lifted',
      }),
    );
  }

  /**
   * Mute the whole room on one or both channels (default: both) — no single
   * target. `chat` flips the room to READ_ONLY (writing straight through the
   * repository rather than `VideoRoomChatSettingsService.update`, which
   * gates on the owner-only `MANAGE_ROOM` permission — this command is
   * already permission-gated on `ROOM_MUTE`, which ADMIN/MODERATOR hold
   * without `MANAGE_ROOM`; going through the settings service would wrongly
   * 403 them). `mic` sweeps every currently-staged participant who doesn't
   * hold an elevated in-room role through the same `media.forceMute` used by
   * a single-user mute.
   *
   * Because the chat-mode write bypasses `VideoRoomChatSettingsService`, it
   * also bypasses that service's `ChatModeChangedEvent` publish — chat
   * clients would never learn the room flipped to READ_ONLY. So this method
   * publishes that same event itself (`publishChatModeChanged`) whenever the
   * `chat` channel is touched, in addition to `RoomModerationUpdatedEvent`.
   */
  async muteAll(
    actor: RoomActor,
    roomId: string,
    channels?: MuteChannel[],
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const chans = channels ?? DEFAULT_MUTE_CHANNELS;
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.ROOM_MUTE);

    let chatSettings: VideoRoomSettings | null = null;
    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      if (chans.includes('chat')) {
        chatSettings = await this.rooms.updateSettings(ref.id, {
          chatMode: VideoRoomChatMode.READ_ONLY,
          // Mirrors VideoRoomChatSettingsService's deprecated-column upkeep.
          allowViewerChat: false,
        });
      }
      if (chans.includes('mic')) {
        const stage = await this.media.getMediaState(actor, ref.id);
        for (const participant of stage.participants) {
          const role = await this.permissions.resolveEffectiveRole(ref, participant.userId);
          if (role && ELEVATED_VIDEO_ROOM_ROLES.includes(role)) continue;
          await this.media.forceMute(actor, ref.id, {
            targetUserId: participant.userId,
            muted: true,
          });
        }
      }
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId: null,
        action: VideoRoomModerationActionType.ROOM_MUTED,
        metadata: this.auditMetadata({ channels: chans }, requestMeta),
      });
    });

    await this.bus.publish(
      new RoomModerationUpdatedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        channels: chans,
        muted: true,
      }),
    );
    await this.publishChatModeChanged(ref, actor, chatSettings, requestMeta);
  }

  /**
   * Reverse of `muteAll`: restores the room chat mode to NORMAL (and, on the
   * `mic` channel, un-force-mutes every currently-staged non-elevated
   * participant `muteAll` would have swept). Restorative, like `unmute` —
   * perm-only (`ROOM_MUTE`), no self-check/owner-protection/outranks. Publishes
   * `RoomModerationUpdatedEvent` (`muted: false`) plus, whenever the `chat`
   * channel is touched, the same `ChatModeChangedEvent` `muteAll` publishes —
   * see that method's doc comment for why the direct publish is needed.
   */
  async unmuteAll(
    actor: RoomActor,
    roomId: string,
    channels?: MuteChannel[],
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const chans = channels ?? DEFAULT_MUTE_CHANNELS;
    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, VideoRoomPermission.ROOM_MUTE);

    let chatSettings: VideoRoomSettings | null = null;
    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      if (chans.includes('chat')) {
        chatSettings = await this.rooms.updateSettings(ref.id, {
          chatMode: VideoRoomChatMode.NORMAL,
          // Mirrors VideoRoomChatSettingsService's deprecated-column upkeep.
          allowViewerChat: true,
        });
      }
      if (chans.includes('mic')) {
        const stage = await this.media.getMediaState(actor, ref.id);
        for (const participant of stage.participants) {
          const role = await this.permissions.resolveEffectiveRole(ref, participant.userId);
          if (role && ELEVATED_VIDEO_ROOM_ROLES.includes(role)) continue;
          await this.media.forceMute(actor, ref.id, {
            targetUserId: participant.userId,
            muted: false,
          });
        }
      }
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId: null,
        action: VideoRoomModerationActionType.ROOM_UNMUTED,
        metadata: this.auditMetadata({ channels: chans }, requestMeta),
      });
    });

    await this.bus.publish(
      new RoomModerationUpdatedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        channels: chans,
        muted: false,
      }),
    );
    await this.publishChatModeChanged(ref, actor, chatSettings, requestMeta);
  }

  // ======================= Warn =======================

  /**
   * Issue a warning: no state change, just a queryable record + the
   * immutable audit trail + a target-only notice. No auto-escalation — the
   * PRD's warning ladder is explicitly out of scope for this phase.
   */
  async warn(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    metadata?: Record<string, unknown>,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.assertPrereqs(
      roomId,
      actor,
      targetUserId,
      VideoRoomPermission.MUTE_USERS,
    );

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      await this.warningRepo.create({
        roomId: ref.id,
        userId: targetUserId,
        moderatorId: actor.id,
        reason,
        metadata: metadata as Prisma.InputJsonValue,
      });
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action: VideoRoomModerationActionType.WARN,
        reason,
        metadata: this.auditMetadata(metadata, requestMeta),
      });
    });

    await this.bus.publish(
      new UserWarnedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        reason,
        metadata: metadata ?? null,
      }),
    );
    this.metrics.incWarning();
    await this.notifyUser(targetUserId, 'video_room.warned', { roomId: ref.id, reason });
  }

  // ======================= Force disconnect =======================

  /**
   * Transient eject: end every realtime session the target holds in this
   * room and hard-disconnect their sockets, but — unlike `kick` — no
   * membership deactivation and no durable mute/block row. They stay a
   * member and may simply reconnect.
   */
  async forceDisconnect(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason?: string,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    const ref = await this.assertPrereqs(
      roomId,
      actor,
      targetUserId,
      VideoRoomPermission.KICK_USERS,
    );

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      await this.session.endUserRoomSessions(ref.id, targetUserId);
      this.sockets.disconnectUserInNamespace(VIDEO_ROOM_NAMESPACE, targetUserId);
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        action: VideoRoomModerationActionType.FORCE_DISCONNECT,
        reason: reason ?? null,
        metadata: this.auditMetadata(undefined, requestMeta),
      });
    });

    await this.bus.publish(
      new UserForceDisconnectedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        reason: reason ?? null,
      }),
    );
  }

  // ======================= Auto-moderation (system) =======================

  /**
   * System-initiated mute (the auto-moderation engine's `auto_mute` outcome —
   * VR-16 Task 19 wires the detectors that call these). Acts as
   * `SYSTEM_MODERATOR_ID`: no permission/outranks checks against a regular
   * target, since there is no human actor to authorize. It still independently
   * exempts the room OWNER and any `ELEVATED_VIDEO_ROOM_ROLES` holder
   * (ADMIN/MODERATOR) — see `isExemptFromAutoAction` — because the automated
   * detectors have no notion of RBAC and would otherwise punish a protected
   * user a human command can never touch (e.g. `OwnerProtectionException`).
   * Idempotent — a second call while a mute is already ACTIVE is a silent
   * no-op rather than a stacked/duplicate mute. Chat-channel only (no `mic`
   * force-mute): the auto-mod surface mutes the room chat, it doesn't touch
   * the media stage.
   */
  async autoMute(
    roomId: string,
    targetUserId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    if (await this.isExemptFromAutoAction(ref, targetUserId)) return;

    const expiresAt = await this.locks.withLock(moderationLockKey(ref.id), async () => {
      const existing = await this.moderationRepo.findActiveMute(ref.id, targetUserId);
      if (existing) return null;

      const expiry = new Date(Date.now() + this.autoMuteMinutes() * 60_000);
      await this.moderationRepo.createMute({
        roomId: ref.id,
        userId: targetUserId,
        moderatorId: SYSTEM_MODERATOR_ID,
        type: VideoRoomModerationMuteType.TEMPORARY,
        reason,
        expiresAt: expiry,
      });
      await this.moderationRepo.addMuteMirror(ref.id, targetUserId, expiry.getTime() - Date.now());
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId,
        action: VideoRoomModerationActionType.AUTO_MUTED,
        reason,
        metadata: { system: true, ...meta } as Prisma.InputJsonValue,
      });
      return expiry;
    });

    if (!expiresAt) return;

    await this.bus.publish(
      new UserMutedEvent({
        roomId: ref.id,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId,
        type: VideoRoomModerationMuteType.TEMPORARY,
        reason,
        expiresAt: expiresAt.toISOString(),
        channels: ['chat'],
      }),
    );
    this.metrics.incAutoAction(this.detectorLabel(meta), 'auto_mute');
  }

  /**
   * System-initiated kick (the auto-moderation engine's `auto_kick`
   * outcome). Reuses the same eject primitive as a human `kick`
   * (`ejectFromRoom`: deactivate + hard-disconnect), skips permission/outranks
   * checks against a regular target (no human actor to authorize), and is
   * idempotent — a target who isn't currently an active member is a silent
   * no-op rather than the `VIDEO_ROOM_NOT_MEMBER` error a human-triggered
   * `kick` would raise. It still independently exempts the room OWNER and any
   * `ELEVATED_VIDEO_ROOM_ROLES` holder (ADMIN/MODERATOR) — see
   * `isExemptFromAutoAction` — so a rapid-join-leave burst from a flaky
   * connection can never auto-eject a protected user the way a human `kick`
   * already can't (`OwnerProtectionException`).
   */
  async autoKick(
    roomId: string,
    targetUserId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    if (await this.isExemptFromAutoAction(ref, targetUserId)) return;

    const kicked = await this.locks.withLock(moderationLockKey(ref.id), async () => {
      const member = await this.rooms.getMember(ref.id, targetUserId);
      if (!member?.isActive) return false;

      await this.ejectFromRoom(ref.id, targetUserId, SYSTEM_MODERATOR_ID);
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId,
        action: VideoRoomModerationActionType.AUTO_KICKED,
        reason,
        metadata: { system: true, ...meta } as Prisma.InputJsonValue,
      });
      return true;
    });

    if (!kicked) return;

    await this.bus.publish(
      new UserKickedEvent({
        roomId: ref.id,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId,
        reason,
      }),
    );
    this.metrics.incAutoAction(this.detectorLabel(meta), 'auto_kick');
    await this.notifyUser(targetUserId, 'video_room.kicked', { roomId: ref.id, reason });
  }

  /**
   * System-initiated flag (the auto-moderation engine's `auto_flag`
   * outcome): no punitive action of its own, just opens a `VideoRoomReport`
   * for human triage via the injected `VideoRoomReportService` — its
   * `createSystemReport` already sets `reporterId = SYSTEM_MODERATOR_ID` and
   * fans out to moderators exactly like a member-filed report. Also exempts
   * the room OWNER and any `ELEVATED_VIDEO_ROOM_ROLES` holder (see
   * `isExemptFromAutoAction`), for consistency with `autoMute`/`autoKick` —
   * the automated detectors have no RBAC context of their own. Still runs
   * under the room's moderation lock for consistency with the other two
   * auto* methods, though it holds no mute/block/member row of its own to
   * serialise.
   */
  async autoFlag(
    roomId: string,
    targetUserId: string,
    reason: VideoRoomReportReason,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const ref = await this.requireRoom(roomId);
    if (await this.isExemptFromAutoAction(ref, targetUserId)) return;

    await this.locks.withLock(moderationLockKey(ref.id), async () => {
      await this.reportService.createSystemReport(ref.id, targetUserId, reason, meta);
      await this.moderationRepo.appendAction({
        roomId: ref.id,
        moderatorId: SYSTEM_MODERATOR_ID,
        targetUserId,
        action: VideoRoomModerationActionType.AUTO_FLAGGED,
        reason,
        metadata: { system: true, ...meta } as Prisma.InputJsonValue,
      });
    });

    this.metrics.incAutoAction(this.detectorLabel(meta), 'auto_flag');
  }

  // ======================= Internals =======================

  /**
   * TEMPORARY requires a positive `durationMinutes`, but only when the `chat`
   * channel is part of the mute — the chat channel is the only one with a
   * persisted expiry row (`VideoRoomMute.expiresAt`); a mic-only mute
   * delegates entirely to `media.forceMute`, which has no notion of duration.
   * So a mic-only TEMPORARY mute needs no `durationMinutes` and simply
   * resolves to a null expiry. PERMANENT always ignores `durationMinutes`.
   */
  private resolveExpiry(
    channels: MuteChannel[],
    type: VideoRoomModerationMuteType,
    durationMinutes?: number,
  ): Date | null {
    if (type !== VideoRoomModerationMuteType.TEMPORARY) return null;
    if (!channels.includes('chat')) return null;
    if (!durationMinutes || durationMinutes <= 0) {
      throw new MuteException(
        ERROR_CODES.VALIDATION_ERROR,
        'A temporary mute requires a positive durationMinutes.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return new Date(Date.now() + durationMinutes * 60_000);
  }

  /**
   * Shared prereq chain for every targeted moderation command: not-self →
   * `permission` → owner-protection → outranks. Platform ADMIN/SUPER_ADMIN
   * bypass owner-protection and the outranks check entirely (account-recovery
   * / emergency moderation), mirroring `VideoRoomRoleService.assertNoEscalation`.
   */
  private async assertPrereqs(
    roomId: string,
    actor: RoomActor,
    targetUserId: string,
    permission: VideoRoomPermission,
  ): Promise<PermissionRoomRef> {
    if (targetUserId === actor.id) {
      throw new ModerationException(
        ERROR_CODES.VIDEO_ROOM_CANNOT_MODERATE_SELF,
        'You cannot moderate yourself.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const ref = await this.requireRoom(roomId);
    await this.permissions.assertPermission(actor, ref, permission);

    if (!this.isPlatformStaff(actor)) {
      if (targetUserId === ref.ownerId) {
        throw new OwnerProtectionException();
      }
      await this.permissions.assertOutranks(ref, actor.id, targetUserId);
    }
    return ref;
  }

  /**
   * Remove a user from the room right now: deactivate + hard-disconnect their
   * sockets in the video-room namespace only. Room-scoped, not
   * `disconnectUserEverywhere` — a video-room kick/blacklist/auto-kick must
   * not tear down the target's DM, 1:1 call, audio-room, or other video-room
   * sockets (spec decision 3).
   */
  private async ejectFromRoom(
    roomId: string,
    targetUserId: string,
    actorId: string,
  ): Promise<void> {
    await this.rooms.deactivateMember(roomId, targetUserId, actorId);
    this.sockets.disconnectUserInNamespace(VIDEO_ROOM_NAMESPACE, targetUserId);
    await this.session.endUserRoomSessions(roomId, targetUserId);
  }

  private async requireRoom(roomId: string): Promise<PermissionRoomRef> {
    const room = await this.rooms.findById(roomId);
    if (!room) {
      throw new BusinessException(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return { id: room.id, ownerId: room.ownerId };
  }

  private isPlatformStaff(actor: RoomActor): boolean {
    return (
      actor.roles.includes(PlatformRole.ADMIN) || actor.roles.includes(PlatformRole.SUPER_ADMIN)
    );
  }

  /**
   * Owner/elevated-role exemption for the auto* (system) methods. A human
   * command can never touch the owner (`assertPrereqs` throws
   * `OwnerProtectionException`) or outrank an elevated role, but the auto*
   * methods have no human actor to run that chain against — so this
   * independently re-derives the same guarantee via
   * `VideoRoomPermissionService.resolveEffectiveRole`, exactly as `muteAll`
   * already does for its per-participant mic sweep. `ELEVATED_VIDEO_ROOM_ROLES`
   * includes OWNER, so a single role lookup covers both the owner and
   * ADMIN/MODERATOR — only regular participants/viewers are auto-moderatable.
   */
  private async isExemptFromAutoAction(
    ref: PermissionRoomRef,
    targetUserId: string,
  ): Promise<boolean> {
    const role = await this.permissions.resolveEffectiveRole(ref, targetUserId);
    return !!role && ELEVATED_VIDEO_ROOM_ROLES.includes(role);
  }

  /**
   * Publishes `ChatModeChangedEvent` for a `muteAll`/`unmuteAll` chat-channel
   * write — see `muteAll`'s doc comment for why this direct publish exists.
   * `settings` is the `updateSettings` result captured inside the lock; a
   * `null` (chat channel not touched) is a silent no-op. Reuses the same
   * event `VideoRoomChatSettingsService.update` publishes so every existing
   * subscriber (the chat socket bridge, the chat audit listener) picks it up
   * without change — `IEventBus` dispatches by `event.name`, not by publisher.
   */
  private async publishChatModeChanged(
    ref: PermissionRoomRef,
    actor: RoomActor,
    settings: VideoRoomSettings | null,
    requestMeta?: RequestMetadata,
  ): Promise<void> {
    if (!settings) return;
    await this.bus.publish(
      new ChatModeChangedEvent({
        roomId: ref.id,
        chatMode: settings.chatMode,
        allowChat: settings.allowChat,
        slowModeSeconds: settings.slowModeSeconds,
        actorId: actor.id,
        audit: requestMeta,
      }),
    );
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : 'Unknown error';
  }

  /**
   * Merges the `{requestId, ip, userAgent}` carried by the controller's
   * `@RequestMeta()` into an action's own `metadata` blob (per spec §8: the
   * append-only audit trail must carry request provenance). Returns
   * `undefined` when neither side has anything to record, so an
   * un-instrumented caller (e.g. a future direct service call with no
   * `requestMeta`) doesn't start writing empty metadata rows.
   */
  private auditMetadata(
    base: Record<string, unknown> | undefined,
    requestMeta?: RequestMetadata,
  ): Prisma.InputJsonValue | undefined {
    if (!base && !requestMeta) return undefined;
    return {
      ...(base ?? {}),
      ...(requestMeta
        ? {
            requestId: requestMeta.requestId ?? null,
            ip: requestMeta.ip ?? null,
            userAgent: requestMeta.userAgent ?? null,
          }
        : {}),
    } as Prisma.InputJsonValue;
  }

  /**
   * `videoRoom.moderation.autoMuteMinutes`, read fresh on every call (no
   * hardcoded fallback threshold) — mirrors `loadVideoRoomConfig`'s "throw if
   * the namespace/field isn't registered" convention rather than silently
   * defaulting a moderation duration.
   */
  private autoMuteMinutes(): number {
    const raw = this.config.get<{ moderation?: { autoMuteMinutes?: number | string } }>(
      'videoRoom',
    );
    const minutes = raw?.moderation?.autoMuteMinutes;
    if (minutes === undefined || minutes === null) {
      throw new Error('videoRoom.moderation.autoMuteMinutes config is not registered');
    }
    return Number(minutes);
  }

  /**
   * The auto-moderation engine (VR-16 Task 19) passes which detector fired
   * in `meta.detector` (e.g. `'spam'`, `'flood'`) so `metrics.incAutoAction`
   * can label the counter by detector; a direct/manual auto* call with no
   * `meta.detector` is labelled `'manual'`.
   */
  private detectorLabel(meta?: Record<string, unknown>): string {
    const detector = meta?.detector;
    return typeof detector === 'string' ? detector : 'manual';
  }

  /**
   * Async notify via the dedicated Phase-16 `PROCESSING` queue
   * (`VIDEO_ROOM_MODERATION_QUEUES.PROCESSING`), not the shared
   * `notifications` queue directly — `ModerationProcessingProcessor` (Task 21)
   * forwards the `notify` job onto `notifications` keyed by `type`, so
   * delivery is unchanged while the moderation domain owns its own
   * worker/retry/dead-letter lane. Mirrors the Audio Room
   * `ModerationService.notifyUser` helper.
   */
  private async notifyUser(
    userId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.queue.add('notify', { type, userId, ...data });
  }
}
