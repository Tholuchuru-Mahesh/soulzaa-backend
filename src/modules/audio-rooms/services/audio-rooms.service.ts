import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  AudioRoom,
  PlatformRole,
  RoomLogAction,
  RoomMemberRole,
  RoomVisibility,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { MAX_STANDARD_ROOMS_PER_USER } from 'src/common/constants/room.constants';
import { LockService } from 'src/infra/redis/lock.service';
import { PresenceService } from 'src/infra/redis/presence.service';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import { ROOM_MIN_PARTICIPANTS } from '../constants/audio-room.constants';
import type { CreateRoomDto } from '../dto/create-room.dto';
import type { JoinRoomDto } from '../dto/join-room.dto';
import type { ListRoomsDto } from '../dto/list-rooms.dto';
import type { UpdateRoomDto } from '../dto/update-room.dto';
import type { TransferOwnershipDto } from '../dto/transfer-ownership.dto';
import {
  RoomCreatedEvent,
  RoomDeletedEvent,
  RoomEndedEvent,
  RoomJoinedEvent,
  RoomLeftEvent,
  RoomLockedEvent,
  RoomOwnershipTransferredEvent,
  RoomUpdatedEvent,
} from '../events/audio-room.events';
import type { IAudioRoomsService, RoomView } from '../interfaces/audio-rooms.service.interface';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsRepository, type UpdateRoomData } from '../repositories/audio-rooms.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import type { RoomPermission } from '../constants/room-permissions';
import { AudioRoomSeatsService } from './audio-room-seats.service';
import { RoomPasswordService } from './room-password.service';
import { RoomPermissionService } from './room-permission.service';

// Re-exported so existing importers (controller, specs) keep resolving RoomActor
// from this module; the canonical definition lives in interfaces/room-actor.
export type { RoomActor } from '../interfaces/room-actor.interface';

/** A room detail view with its live participant roster. */
export interface RoomDetailView extends RoomView {
  participants: RoomParticipant[];
}

export interface RoomParticipant {
  userId: string;
  username: string | null;
  role: RoomMemberRole;
  joinedAt: Date;
}

/**
 * Audio Room lifecycle service (PHASE AR-0). Owns room create/edit/delete/end,
 * join/leave, ownership transfer and lock, backed by Postgres (durable record),
 * Redis (authoritative live presence + snapshot cache + trending) and the
 * EVENT_BUS (realtime `room.*` fan-out + downstream analytics/notifications).
 * Concurrency-sensitive paths (per-user create limit, capacity, ownership
 * transfer) run under a distributed lock.
 */
/** Succession order when an owner is removed — highest wins (OWNER never chosen). */
const OWNER_SUCCESSION_PRIORITY: Record<RoomMemberRole, number> = {
  [RoomMemberRole.OWNER]: 6,
  [RoomMemberRole.ADMIN]: 5,
  [RoomMemberRole.PREMIUM_ADMIN]: 4,
  [RoomMemberRole.SPEAKER]: 3,
  [RoomMemberRole.LISTENER]: 2,
  [RoomMemberRole.AUDIENCE]: 1,
};

@Injectable()
export class AudioRoomsService implements IAudioRoomsService {
  private readonly logger = new Logger(AudioRoomsService.name);
  private readonly defaultMax: number;
  private readonly maxCap: number;
  private readonly cacheTtl: number;
  private readonly defaultSpeakerSeats: number;
  private readonly defaultPremiumAdminSeats: number;

  constructor(
    private readonly repo: AudioRoomsRepository,
    private readonly presence: PresenceService,
    private readonly locks: LockService,
    private readonly passwords: RoomPasswordService,
    private readonly config: ConfigService,
    private readonly permissions: RoomPermissionService,
    private readonly seatsService: AudioRoomSeatsService,
    private readonly moderation: ModerationRepository,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
  ) {
    // Config namespaces surface raw process.env strings at runtime, so coerce.
    const cfg = this.config.get('audioRoom') as {
      defaultMaxParticipants: number | string;
      maxParticipantsCap: number | string;
      cacheTtlSeconds: number | string;
      defaultSpeakerSeats: number | string;
      defaultPremiumAdminSeats: number | string;
    };
    this.defaultMax = Number(cfg.defaultMaxParticipants);
    this.maxCap = Number(cfg.maxParticipantsCap);
    this.cacheTtl = Number(cfg.cacheTtlSeconds);
    this.defaultSpeakerSeats = Number(cfg.defaultSpeakerSeats);
    this.defaultPremiumAdminSeats = Number(cfg.defaultPremiumAdminSeats);
  }

  // ======================= Commands =======================

  async create(actor: RoomActor, dto: CreateRoomDto): Promise<RoomView> {
    return this.locks.withLock(`audio-room:create:{${actor.id}}`, async () => {
      const owned = await this.repo.countActiveRoomsOwnedBy(actor.id);
      if (owned >= MAX_STANDARD_ROOMS_PER_USER) {
        throw new BusinessException(
          ERROR_CODES.ROOM_LIMIT_REACHED,
          'You already have an active audio room.',
          HttpStatus.CONFLICT,
        );
      }

      if (dto.categoryId) await this.assertCategory(dto.categoryId);
      if (dto.language) await this.assertLanguage(dto.language);

      const passwordHash = dto.password ? await this.passwords.hash(dto.password) : null;
      const room = await this.repo.createRoomTx({
        ownerId: actor.id,
        name: dto.name,
        description: dto.description ?? null,
        imageKey: dto.imageKey ?? null,
        categoryId: dto.categoryId ?? null,
        language: dto.language ?? null,
        visibility: dto.visibility ?? RoomVisibility.PUBLIC,
        isLocked: dto.isLocked ?? false,
        passwordHash,
        isDiscoverable: dto.isDiscoverable ?? true,
        maxParticipants: this.clampMax(dto.maxParticipants),
        agoraChannel: randomUUID(),
        zegoRoomId: randomUUID(),
        speakerSeatCount: this.defaultSpeakerSeats,
        premiumAdminSeatCount: this.defaultPremiumAdminSeats,
        requireApprovalForSeat: true,
      });

      const view = await this.toView(room);
      await this.repo.setCachedSnapshot(view, this.cacheTtl);
      await this.bus.publish(
        new RoomCreatedEvent({
          roomId: room.id,
          ownerId: room.ownerId,
          name: room.name,
          categoryId: room.categoryId,
          language: room.language,
          visibility: room.visibility,
        }),
      );
      return view;
    });
  }

  async update(actor: RoomActor, roomId: string, dto: UpdateRoomDto): Promise<RoomView> {
    await this.getManageableRoom(roomId, actor);

    if (dto.categoryId) await this.assertCategory(dto.categoryId);
    if (dto.language) await this.assertLanguage(dto.language);

    const data: UpdateRoomData = {};
    const changed: string[] = [];
    const assign = <K extends keyof UpdateRoomData>(key: K, value: UpdateRoomData[K]): void => {
      data[key] = value;
      changed.push(key);
    };

    if (dto.name !== undefined) assign('name', dto.name);
    if (dto.description !== undefined) assign('description', dto.description);
    if (dto.imageKey !== undefined) assign('imageKey', dto.imageKey);
    if (dto.categoryId !== undefined) assign('categoryId', dto.categoryId);
    if (dto.language !== undefined) assign('language', dto.language);
    if (dto.visibility !== undefined) assign('visibility', dto.visibility);
    if (dto.isDiscoverable !== undefined) assign('isDiscoverable', dto.isDiscoverable);
    if (dto.maxParticipants !== undefined)
      assign('maxParticipants', this.clampMax(dto.maxParticipants));
    if (dto.isLocked !== undefined) assign('isLocked', dto.isLocked);
    if (dto.password !== undefined) {
      assign('passwordHash', dto.password ? await this.passwords.hash(dto.password) : null);
      changed[changed.length - 1] = 'password';
    }

    const updated = await this.repo.updateRoom(roomId, data, actor.id);

    if (dto.imageKey !== undefined) {
      await this.repo.appendLog(roomId, actor.id, RoomLogAction.IMAGE_UPDATED);
    }
    if (dto.isLocked !== undefined) {
      await this.repo.appendLog(
        roomId,
        actor.id,
        dto.isLocked ? RoomLogAction.LOCKED : RoomLogAction.UNLOCKED,
      );
      await this.bus.publish(
        new RoomLockedEvent({ roomId, actorId: actor.id, isLocked: dto.isLocked }),
      );
    }
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.UPDATED, { changed });

    const view = await this.refreshCache(updated);
    await this.bus.publish(new RoomUpdatedEvent({ roomId, actorId: actor.id, changed }));
    return view;
  }

  async setLock(actor: RoomActor, roomId: string, isLocked: boolean): Promise<RoomView> {
    return this.update(actor, roomId, { isLocked });
  }

  async remove(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.getManageableRoom(roomId, actor);
    await this.repo.softDeleteRoom(roomId, actor.id);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.DELETED);
    await this.clearRoomRuntime(roomId);
    await this.bus.publish(
      new RoomDeletedEvent({ roomId, actorId: actor.id, ownerId: room.ownerId }),
    );
  }

  async end(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.getManageableRoom(roomId, actor);
    const durationSeconds = (Date.now() - room.createdAt.getTime()) / 1000;
    await this.repo.endRoom(roomId, actor.id, durationSeconds);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.ENDED, {
      durationSeconds: Math.floor(durationSeconds),
    });
    await this.clearRoomRuntime(roomId);
    await this.bus.publish(
      new RoomEndedEvent({
        roomId,
        actorId: actor.id,
        ownerId: room.ownerId,
        durationSeconds: Math.floor(durationSeconds),
      }),
    );
  }

  async join(actor: RoomActor, roomId: string, dto: JoinRoomDto): Promise<RoomDetailView> {
    const room = await this.getLiveRoomOrThrow(roomId);

    // Re-entry restriction: a user with an active ban cannot rejoin (AR-3).
    await this.assertNotBanned(roomId, actor.id);

    if (room.isLocked && room.passwordHash) {
      const ok = dto.password
        ? await this.passwords.verify(dto.password, room.passwordHash)
        : false;
      if (!ok) {
        throw new BusinessException(
          ERROR_CODES.ROOM_PASSWORD_INVALID,
          'Incorrect room password.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    await this.locks.withLock(`audio-room:join:{${roomId}}`, async () => {
      const alreadyIn = await this.presence.isInRoom(roomId, actor.id);
      if (!alreadyIn) {
        const count = await this.presence.roomMemberCount(roomId);
        if (count >= room.maxParticipants) {
          throw new BusinessException(
            ERROR_CODES.ROOM_FULL,
            'This room is full.',
            HttpStatus.CONFLICT,
          );
        }
      }
      await this.presence.joinRoom(roomId, actor.id);
      const role = room.ownerId === actor.id ? RoomMemberRole.OWNER : RoomMemberRole.LISTENER;
      await this.repo.upsertActiveMember(roomId, actor.id, role, actor.id);
      await this.repo.upsertPresence(roomId, actor.id);
    });

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnJoin(roomId, count);
    await this.repo.trendingBump(roomId);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.JOINED);
    await this.bus.publish(
      new RoomJoinedEvent({ roomId, userId: actor.id, participantCount: count }),
    );
    return this.getRoomDetail(roomId);
  }

  async leave(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();

    await this.presence.leaveRoom(roomId, actor.id);
    await this.repo.deactivateMember(roomId, actor.id, actor.id);
    await this.repo.removePresence(roomId, actor.id);

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnLeave(roomId, count);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.LEFT);
    await this.bus.publish(
      new RoomLeftEvent({ roomId, userId: actor.id, participantCount: count }),
    );
  }

  async transferOwnership(
    actor: RoomActor,
    roomId: string,
    dto: TransferOwnershipDto,
  ): Promise<RoomView> {
    const room = await this.getManageableRoom(roomId, actor);
    if (dto.newOwnerId === room.ownerId) {
      throw new BusinessException(
        ERROR_CODES.CONFLICT,
        'User is already the room owner.',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.locks.withLock(`audio-room:transfer:{${roomId}}`, async () => {
      const newOwnerMember = await this.repo.getMember(roomId, dto.newOwnerId);
      if (!newOwnerMember || !newOwnerMember.isActive) {
        throw new BusinessException(
          ERROR_CODES.NOT_ROOM_MEMBER,
          'The new owner must be an active member of the room.',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Demote the previous owner to ADMIN, promote the new owner.
      await this.repo.setMemberRole(roomId, room.ownerId, RoomMemberRole.ADMIN, actor.id);
      await this.repo.setMemberRole(roomId, dto.newOwnerId, RoomMemberRole.OWNER, actor.id);
      return this.repo.setOwner(roomId, dto.newOwnerId, actor.id);
    });

    await this.repo.appendLog(roomId, actor.id, RoomLogAction.OWNERSHIP_TRANSFERRED, {
      previousOwnerId: room.ownerId,
      newOwnerId: dto.newOwnerId,
    });
    const view = await this.refreshCache(updated);
    await this.bus.publish(
      new RoomOwnershipTransferredEvent({
        roomId,
        previousOwnerId: room.ownerId,
        newOwnerId: dto.newOwnerId,
        actorId: actor.id,
      }),
    );
    return view;
  }

  /**
   * Admin "remove owner": strip ownership from the current owner and promote the
   * highest-ranking remaining active member to OWNER (demoting the old owner to
   * LISTENER). If the room has no other active member, the room is closed. The
   * acting admin never becomes the owner.
   */
  async removeOwner(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.getManageableRoom(roomId, actor);

    const members = await this.repo.listActiveMembers(roomId);
    const successor = members
      .filter((m) => m.userId !== room.ownerId)
      .sort(
        (a, b) =>
          OWNER_SUCCESSION_PRIORITY[b.role] - OWNER_SUCCESSION_PRIORITY[a.role] ||
          a.joinedAt.getTime() - b.joinedAt.getTime(),
      )[0];

    // No one to hand the room to — closing it is the only sane outcome.
    if (!successor) {
      await this.end(actor, roomId);
      return;
    }

    await this.locks.withLock(`audio-room:transfer:{${roomId}}`, async () => {
      await this.repo.setMemberRole(roomId, room.ownerId, RoomMemberRole.LISTENER, actor.id);
      await this.repo.setMemberRole(roomId, successor.userId, RoomMemberRole.OWNER, actor.id);
      await this.repo.setOwner(roomId, successor.userId, actor.id);
    });

    await this.repo.appendLog(roomId, actor.id, RoomLogAction.OWNERSHIP_TRANSFERRED, {
      previousOwnerId: room.ownerId,
      newOwnerId: successor.userId,
      removedByAdmin: true,
    });

    const updated = await this.repo.findRoomRow(roomId);
    if (updated) {
      await this.refreshCache(updated);
    }

    await this.bus.publish(
      new RoomOwnershipTransferredEvent({
        roomId,
        previousOwnerId: room.ownerId,
        newOwnerId: successor.userId,
        actorId: actor.id,
      }),
    );
  }

  // ======================= Queries =======================

  async getRoomDetail(roomId: string): Promise<RoomDetailView> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    const view = await this.toView(room);
    const members = await this.repo.listActiveMembers(roomId);
    const participants = await Promise.all(
      members.map(async (m) => {
        const user = await this.users.findById(m.userId).catch(() => null);
        return {
          userId: m.userId,
          username: user?.username ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );
    return { ...view, participants };
  }

  /** The caller's active owned room, or null when they own none. */
  async getMyRoom(actor: RoomActor): Promise<RoomView | null> {
    const room = await this.repo.findOwnedLiveRoom(actor.id);
    return room ? this.toView(room) : null;
  }

  async list(query: ListRoomsDto, actor: RoomActor): Promise<Paginated<RoomView>> {
    const privileged = this.isPlatformAdmin(actor.roles);
    const { rows, total } = await this.repo.listRooms({
      skip: query.skip,
      take: query.limit,
      categoryId: query.categoryId,
      language: query.language,
      search: query.search,
      visibility: privileged ? query.visibility : undefined,
      discoverableOnly: !privileged,
    });
    const views = await Promise.all(rows.map((r) => this.toView(r)));
    return buildPaginated(views, total, query.page, query.limit);
  }

  async trending(limit: number): Promise<RoomView[]> {
    const ids = await this.repo.trendingTopIds(limit);
    let rows = await this.repo.findLiveRoomsByIds(ids);
    rows = rows.filter((r) => r.isDiscoverable && r.visibility === RoomVisibility.PUBLIC);
    if (rows.length < limit) {
      const fallback = await this.repo.listTopRoomsByStatistics(limit);
      const seen = new Set(rows.map((r) => r.id));
      for (const r of fallback) {
        if (rows.length >= limit) break;
        if (!seen.has(r.id)) rows.push(r);
      }
    }
    return Promise.all(rows.slice(0, limit).map((r) => this.toView(r)));
  }

  listCategories() {
    return this.repo.listActiveCategories();
  }

  listLanguages() {
    return this.repo.listActiveLanguages();
  }

  // ======================= Public contract (IAudioRoomsService) =======================

  async getRoom(roomId: string): Promise<RoomView | null> {
    const cached = await this.repo.getCachedSnapshot(roomId);
    if (cached) return { ...cached, participantCount: await this.participantCount(roomId) };
    const room = await this.repo.findRoomRow(roomId);
    if (!room) return null;
    const view = await this.toView(room);
    await this.repo.setCachedSnapshot(view, this.cacheTtl);
    return view;
  }

  async isRoomLive(roomId: string): Promise<boolean> {
    const room = await this.repo.findLiveRoomRow(roomId);
    return room !== null;
  }

  async getOwnerId(roomId: string): Promise<string | null> {
    const room = await this.repo.findRoomRow(roomId);
    return room?.ownerId ?? null;
  }

  async isMember(roomId: string, userId: string): Promise<boolean> {
    const member = await this.repo.getMember(roomId, userId);
    return member?.isActive === true;
  }

  async getMemberRole(roomId: string, userId: string): Promise<RoomMemberRole | null> {
    // Effective role: room_roles grant → speaker seat → listener (AR-1).
    return this.permissions.getEffectiveRole(roomId, userId);
  }

  async assertMember(roomId: string, userId: string): Promise<void> {
    if (!(await this.isMember(roomId, userId))) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_MEMBER,
        'You are not a member of this room.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  participantCount(roomId: string): Promise<number> {
    return this.presence.roomMemberCount(roomId);
  }

  getEffectiveRole(roomId: string, userId: string): Promise<RoomMemberRole | null> {
    return this.permissions.getEffectiveRole(roomId, userId);
  }

  hasRoomPermission(roomId: string, userId: string, permission: RoomPermission): Promise<boolean> {
    return this.permissions.userHasPermission(roomId, userId, permission);
  }

  isSpeaker(roomId: string, userId: string): Promise<boolean> {
    return this.permissions.isSpeaker(roomId, userId);
  }

  isRoomMuted(roomId: string): Promise<boolean> {
    return this.seatsService.isRoomMuted(roomId);
  }

  isSeatMuted(roomId: string, userId: string): Promise<boolean> {
    return this.seatsService.isSeatMuted(roomId, userId);
  }

  getStage(roomId: string) {
    return this.seatsService.getStage(roomId);
  }

  // ======================= Internals =======================

  private clampMax(requested?: number): number {
    const value = requested ?? this.defaultMax;
    return Math.min(this.maxCap, Math.max(ROOM_MIN_PARTICIPANTS, value));
  }

  private isPlatformAdmin(roles: PlatformRole[]): boolean {
    return roles.includes(PlatformRole.ADMIN) || roles.includes(PlatformRole.SUPER_ADMIN);
  }

  /** Fetch a non-deleted room and assert the actor may manage it (owner/admin). */
  private async getManageableRoom(roomId: string, actor: RoomActor): Promise<AudioRoom> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    if (room.ownerId !== actor.id && !this.isPlatformAdmin(actor.roles)) {
      throw new BusinessException(
        ERROR_CODES.NOT_ROOM_OWNER,
        'Only the room owner or a platform admin can manage this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    return room;
  }

  /**
   * Throws ROOM_BANNED when the user has an active ban. Redis is the fast path;
   * the DB is consulted only on a cache miss (and warms the cache), so a ban
   * survives a Redis flush.
   */
  private async assertNotBanned(roomId: string, userId: string): Promise<void> {
    if (await this.moderation.isBannedCached(roomId, userId)) {
      throw new BusinessException(
        ERROR_CODES.ROOM_BANNED,
        'You are banned from this room.',
        HttpStatus.FORBIDDEN,
      );
    }
    const ban = await this.moderation.findActiveBan(roomId, userId);
    if (ban) {
      // Warm the cache (respecting a temporary ban's remaining TTL).
      const ttlMs = ban.expiresAt ? ban.expiresAt.getTime() - Date.now() : null;
      if (ttlMs === null || ttlMs > 0) {
        await this.moderation.addBanCache(roomId, userId, ttlMs);
        throw new BusinessException(
          ERROR_CODES.ROOM_BANNED,
          'You are banned from this room.',
          HttpStatus.FORBIDDEN,
        );
      }
    }
  }

  private async getLiveRoomOrThrow(roomId: string): Promise<AudioRoom> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();
    if (room.status !== 'LIVE') {
      throw new BusinessException(
        ERROR_CODES.ROOM_ENDED,
        'This room has ended.',
        HttpStatus.CONFLICT,
      );
    }
    return room;
  }

  private async assertCategory(categoryId: string): Promise<void> {
    if (!(await this.repo.categoryExists(categoryId))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_CATEGORY_INVALID,
        'Unknown room category.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertLanguage(code: string): Promise<void> {
    if (!(await this.repo.languageExists(code))) {
      throw new BusinessException(
        ERROR_CODES.ROOM_LANGUAGE_INVALID,
        'Unsupported room language.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async toView(room: AudioRoom): Promise<RoomView> {
    return {
      id: room.id,
      ownerId: room.ownerId,
      name: room.name,
      description: room.description,
      imageKey: room.imageKey,
      categoryId: room.categoryId,
      language: room.language,
      visibility: room.visibility,
      isLocked: room.isLocked,
      isPasswordProtected: room.passwordHash !== null,
      isDiscoverable: room.isDiscoverable,
      maxParticipants: room.maxParticipants,
      status: room.status,
      participantCount: await this.presence.roomMemberCount(room.id),
      agoraChannel: room.agoraChannel,
      zegoRoomId: room.zegoRoomId,
      createdAt: room.createdAt,
      endedAt: room.endedAt,
    };
  }

  private async refreshCache(room: AudioRoom): Promise<RoomView> {
    const view = await this.toView(room);
    await this.repo.setCachedSnapshot(view, this.cacheTtl);
    return view;
  }

  /** Evict a room's live runtime state from Redis (cache, presence, trending). */
  private async clearRoomRuntime(roomId: string): Promise<void> {
    await this.repo.invalidateSnapshot(roomId);
    await this.repo.trendingRemove(roomId);
    const members = await this.presence.roomMembers(roomId);
    await Promise.all(members.map((userId) => this.presence.leaveRoom(roomId, userId)));
  }

  private roomNotFound(): BusinessException {
    return new BusinessException(
      ERROR_CODES.ROOM_NOT_FOUND,
      'Room not found.',
      HttpStatus.NOT_FOUND,
    );
  }
}
