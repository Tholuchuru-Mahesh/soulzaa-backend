import { Injectable, Logger } from '@nestjs/common';
import { VideoRoomStatus } from '@prisma/client';
import { CacheService } from 'src/infra/redis/cache.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  AdminListRoomsQueryDto,
  BanUserAdminDto,
  MuteUserAdminDto,
  ReviewReportAdminDto,
} from '../dto/video-room-admin.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomsAdminRepository } from '../repositories/video-rooms-admin.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomEventService } from './video-room-event.service';
import { VideoRoomModerationService } from './video-room-moderation.service';
import { VideoRoomReportService } from './video-room-report.service';
import { VideoRoomSeatService } from './video-room-seat.service';

const DASHBOARD_CACHE_KEY = 'admin:video-rooms:dashboard-overview';
const DASHBOARD_CACHE_TTL = 15;

@Injectable()
export class VideoRoomsAdminService {
  private readonly logger = new Logger(VideoRoomsAdminService.name);

  constructor(
    private readonly seatService: VideoRoomSeatService,
    private readonly roomsRepository: VideoRoomsRepository,
    private readonly adminRepository: VideoRoomsAdminRepository,
    private readonly moderationService: VideoRoomModerationService,
    private readonly reportService: VideoRoomReportService,
    private readonly eventService: VideoRoomEventService,
    private readonly analyticsProjectionRepository: VideoRoomAnalyticsProjectionRepository,
    private readonly sockets: SocketManager,
    private readonly cacheService: CacheService,
  ) {}

  async getDashboardOverview(_actor: RoomActor) {
    const cached = await this.cacheService.get<Record<string, unknown>>(DASHBOARD_CACHE_KEY);
    if (cached) {
      return cached;
    }

    const { items: allRooms, total: totalRooms } = await this.adminRepository.listRooms({
      take: 1000,
    });
    const liveRooms = allRooms.filter((r) => r.status === VideoRoomStatus.LIVE).length;
    const lockedRooms = allRooms.filter((r) => r.isLocked).length;
    const endedRooms = allRooms.filter((r) => r.status === VideoRoomStatus.ENDED).length;

    const snapshots = await this.analyticsProjectionRepository.getAnalyticsSnapshots(
      'video_room',
      undefined,
      1,
    );
    const analyticsSnapshot = snapshots.length > 0 ? snapshots[0] : null;

    const overview = {
      summary: {
        totalRooms,
        liveRooms,
        lockedRooms,
        endedRooms,
      },
      analytics: analyticsSnapshot
        ? {
            activeViewers: (analyticsSnapshot.metrics as any)?.totalViewers ?? 0,
            peakViewers: (analyticsSnapshot.metrics as any)?.peakConcurrentViewers ?? 0,
            totalGifts: (analyticsSnapshot.metrics as any)?.totalGiftsSent ?? 0,
          }
        : null,
      timestamp: new Date().toISOString(),
    };

    await this.cacheService.set(DASHBOARD_CACHE_KEY, overview, DASHBOARD_CACHE_TTL);
    return overview;
  }

  async listRooms(actor: RoomActor, query: AdminListRoomsQueryDto) {
    return this.adminRepository.listRooms({
      skip: query.skip,
      take: query.limit,
      status: query.status,
      ownerId: query.ownerId,
      isLocked: query.isLocked,
      search: query.search,
    });
  }

  async getRoomDetail(actor: RoomActor, roomId: string) {
    return this.adminRepository.getRoomDetail(roomId);
  }

  async remove(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.roomsRepository.findById(roomId);
    await this.roomsRepository.softDelete(roomId, actor.id);
    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_DELETE_ROOM',
      actorId: actor.id,
    });

    if (room) {
      await this.eventService.emitRoomDeleted({ roomId, actorId: actor.id, ownerId: room.ownerId });
    }
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:room_deleted', {
      roomId,
      actorId: actor.id,
    });
  }

  async end(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.roomsRepository.findById(roomId);
    await this.roomsRepository.updateStatus(roomId, VideoRoomStatus.ENDED, actor.id);
    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_CLOSE_ROOM',
      actorId: actor.id,
    });

    if (room) {
      await this.eventService.emitRoomClosed({
        roomId,
        actorId: actor.id,
        ownerId: room.ownerId,
        durationSeconds: 0,
      });
    }
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:room_closed', {
      roomId,
      actorId: actor.id,
    });
  }

  async setLock(actor: RoomActor, roomId: string, isLocked: boolean) {
    const updated = await this.roomsRepository.updateRoom(roomId, { isLocked }, actor.id);
    await this.adminRepository.createRoomLog({
      roomId,
      action: isLocked ? 'ADMIN_LOCK_ROOM' : 'ADMIN_UNLOCK_ROOM',
      actorId: actor.id,
      details: { isLocked },
    });

    await this.eventService.emitRoomLocked({ roomId, isLocked, actorId: actor.id });
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:room_locked', {
      roomId,
      isLocked,
      actorId: actor.id,
    });

    return updated;
  }

  async removeOwner(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.roomsRepository.findById(roomId);
    await this.roomsRepository.updateStatus(roomId, VideoRoomStatus.ENDED, actor.id);
    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_REMOVE_OWNER',
      actorId: actor.id,
    });

    if (room) {
      await this.eventService.emitRoomClosed({
        roomId,
        actorId: actor.id,
        ownerId: room.ownerId,
        durationSeconds: 0,
      });
    }
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:owner_removed', {
      roomId,
      actorId: actor.id,
    });
  }

  async removeParticipant(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason?: string,
  ): Promise<void> {
    try {
      const targetActor: RoomActor = { id: targetUserId, roles: [] };
      await this.seatService.leaveSeat(targetActor, roomId);
    } catch {
      // Ignored if target user is not currently seated
    }

    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_REMOVE_PARTICIPANT',
      actorId: actor.id,
      details: { targetUserId, reason },
    });

    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:participant_removed', {
      roomId,
      targetUserId,
      actorId: actor.id,
      reason,
    });
  }

  async disableChat(actor: RoomActor, roomId: string, isChatDisabled: boolean): Promise<void> {
    await this.roomsRepository.updateSettings(roomId, {
      isChatMuted: isChatDisabled,
    } as any);

    await this.adminRepository.createRoomLog({
      roomId,
      action: isChatDisabled ? 'ADMIN_DISABLE_CHAT' : 'ADMIN_ENABLE_CHAT',
      actorId: actor.id,
      details: { isChatDisabled },
    });

    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, 'admin:chat_disabled', {
      roomId,
      isChatDisabled,
      actorId: actor.id,
    });
  }

  async banUser(actor: RoomActor, roomId: string, targetUserId: string, dto: BanUserAdminDto) {
    const res = await this.moderationService.blacklist(actor, roomId, targetUserId, {
      reason: dto.reason,
      durationSeconds: dto.durationSeconds,
    } as any);

    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_BAN_USER',
      actorId: actor.id,
      details: { targetUserId, reason: dto.reason, durationSeconds: dto.durationSeconds },
    });

    return res;
  }

  async unbanUser(actor: RoomActor, roomId: string, targetUserId: string) {
    await this.moderationService.unblacklist(actor, roomId, targetUserId);
    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_UNBAN_USER',
      actorId: actor.id,
      details: { targetUserId },
    });
  }

  async muteUser(actor: RoomActor, roomId: string, targetUserId: string, dto: MuteUserAdminDto) {
    const res = await this.moderationService.mute(actor, roomId, {
      targetUserId,
      reason: dto.reason,
      durationSeconds: dto.durationSeconds,
    } as any);

    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_MUTE_USER',
      actorId: actor.id,
      details: { targetUserId, reason: dto.reason, durationSeconds: dto.durationSeconds },
    });

    return res;
  }

  async unmuteUser(actor: RoomActor, roomId: string, targetUserId: string) {
    await this.moderationService.unmute(actor, roomId, {
      targetUserId,
    } as any);

    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_UNMUTE_USER',
      actorId: actor.id,
      details: { targetUserId },
    });
  }

  async reviewReport(
    actor: RoomActor,
    roomId: string,
    reportId: string,
    dto: ReviewReportAdminDto,
  ) {
    await this.reportService.reviewReport(actor, roomId, reportId, {
      status: dto.status,
      resolutionAction: dto.note,
    });

    await this.adminRepository.createRoomLog({
      roomId,
      action: 'ADMIN_REVIEW_REPORT',
      actorId: actor.id,
      details: { reportId, status: dto.status, note: dto.note },
    });
  }
}
