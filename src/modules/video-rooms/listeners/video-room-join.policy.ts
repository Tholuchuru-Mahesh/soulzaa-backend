import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  ROOM_JOIN_POLICY_REGISTRY,
  type RoomJoinPolicy,
  type RoomJoinPolicyRegistry,
} from 'src/infra/socket/room-join-policy.interface';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomGiftLockAccessRepository } from '../repositories/video-room-gift-lock-access.repository';

/**
 * Opt-in authorization hook for `SocketManager.joinRoom` on `/video-room`.
 *
 * Ensures that if a video room has gift-lock enabled, a user cannot join the
 * socket room channel, register in room presence, or trigger a "user joined"
 * broadcast until they have either:
 *  1. Satisfied the gift-lock by sending the required entry gift for the active broadcast session, OR
 *  2. Are the room owner, moderator/admin, or already an active member of the room.
 */
@Injectable()
export class VideoRoomJoinPolicy implements RoomJoinPolicy, OnModuleInit {
  constructor(
    @Inject(ROOM_JOIN_POLICY_REGISTRY) private readonly registry: RoomJoinPolicyRegistry,
    private readonly repo: VideoRoomsRepository,
    private readonly giftLockAccessRepo: VideoRoomGiftLockAccessRepository,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.set(VIDEO_ROOM_NAMESPACE, this);
  }

  async canJoin(userId: string, roomId: string): Promise<'player' | 'spectator' | 'deny'> {
    if (!isUUID(roomId, '4')) return 'deny';

    const room = await this.repo.findById(roomId);
    if (!room || room.status !== 'LIVE') return 'deny';

    // If gift-lock is disabled for this room, join is allowed.
    if (!room.giftLockEnabled) return 'player';

    // Room owner / host is always allowed.
    if (room.ownerId === userId) return 'player';

    // Staff and moderators are exempt from gift locks.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { roles: true },
    });
    const roles: string[] = (user?.roles ?? []).map((r) => r.toUpperCase());
    const isStaffOrMod = roles.some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (isStaffOrMod) return 'player';

    // Already-active member in this room.
    const member = await this.repo.getMember(roomId, userId);
    if (member && member.isActive) return 'player';

    // Verify granted gift-lock access for the current active broadcast session.
    const activeSession = await this.repo.getActiveBroadcastSession(roomId);
    if (activeSession) {
      const hasAccess = await this.giftLockAccessRepo.hasGrantedAccess(
        userId,
        activeSession.id,
      );
      if (hasAccess) return 'player';
    }

    return 'deny';
  }
}
