import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ListModerationDto } from '../dto/moderation.dto';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import {
  AdminListRoomsQueryDto,
  BanUserAdminDto,
  DisableChatAdminDto,
  LockRoomAdminDto,
  MuteUserAdminDto,
  RemoveParticipantAdminDto,
  ReviewReportAdminDto,
} from '../dto/video-room-admin.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomsAdminRepository } from '../repositories/video-rooms-admin.repository';
import { VideoRoomModerationRepository } from '../repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from '../repositories/video-room-report.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomsAdminService } from '../services/video-rooms-admin.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

export class VideoRoomSlowModeAdminDto {
  slowMode!: boolean;
}

@ApiTags('video-rooms-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/video-rooms')
export class VideoRoomsAdminController {
  constructor(
    private readonly adminService: VideoRoomsAdminService,
    private readonly adminRepository: VideoRoomsAdminRepository,
    private readonly roomsRepository: VideoRoomsRepository,
    private readonly moderationRepository: VideoRoomModerationRepository,
    private readonly reportRepository: VideoRoomReportRepository,
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Get('dashboard/overview')
  @ApiOperation({ summary: 'Operational dashboard overview for video rooms' })
  async getDashboardOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.adminService.getDashboardOverview(this.actor(user));
  }

  @Get()
  @ApiOperation({ summary: 'List/search video rooms for administration' })
  async listRooms(@CurrentUser() user: AuthenticatedUser, @Query() q: AdminListRoomsQueryDto) {
    const { items, total } = await this.adminService.listRooms(this.actor(user), q);
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get detailed video room info for administration' })
  async getRoomDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    return this.adminService.getRoomDetail(this.actor(user), id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete/disband a video room permanently' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.adminService.remove(this.actor(user), id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the active video room live session' })
  async end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.adminService.end(this.actor(user), id);
    return { ended: true };
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock or unlock a video room' })
  async lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockRoomAdminDto,
  ) {
    return this.adminService.setLock(this.actor(user), id, dto.isLocked);
  }

  @Post(':id/remove-owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the video room owner' })
  async removeOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.adminService.removeOwner(this.actor(user), id);
    return { ownerRemoved: true };
  }

  @Post(':id/remove-participant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove/kick a participant from a video room' })
  async removeParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RemoveParticipantAdminDto,
  ) {
    await this.adminService.removeParticipant(this.actor(user), id, dto.targetUserId, dto.reason);
    return { participantRemoved: true };
  }

  @Post(':id/disable-chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable or enable chat in a video room' })
  async disableChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: DisableChatAdminDto,
  ) {
    await this.adminService.disableChat(this.actor(user), id, dto.isChatDisabled);
    return { chatDisabled: dto.isChatDisabled };
  }

  @Post(':id/moderation/ban/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a user from a video room administratively' })
  async banUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserAdminDto,
  ) {
    await this.adminService.banUser(this.actor(user), id, userId, dto);
    return { banned: true };
  }

  @Post(':id/moderation/unban/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unban a user from a video room administratively' })
  async unbanUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.adminService.unbanUser(this.actor(user), id, userId);
    return { unbanned: true };
  }

  @Post(':id/moderation/mute/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute a user in a video room administratively' })
  async muteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: MuteUserAdminDto,
  ) {
    await this.adminService.muteUser(this.actor(user), id, userId, dto);
    return { muted: true };
  }

  @Post(':id/moderation/unmute/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute a user in a video room administratively' })
  async unmuteUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.adminService.unmuteUser(this.actor(user), id, userId);
    return { unmuted: true };
  }

  @Post(':id/reports/:reportId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review/resolve a moderation report' })
  async reviewReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ReviewReportAdminDto,
  ) {
    await this.adminService.reviewReport(this.actor(user), id, reportId, dto);
    return { reportReviewed: true };
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List active members/participants of the video room' })
  async members(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const members = await this.roomsRepository.listActiveMembers(id, q.limit || 20, q.skip || 0);
    return members;
  }

  @Get(':id/gifts')
  @ApiOperation({ summary: 'View paginated gift transactions for the video room' })
  async gifts(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = {
      contextId: id,
      contextType: 'VIDEO_ROOM' as const,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.giftTransaction.findMany({
        where,
        skip: q.skip || 0,
        take: q.limit || 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.giftTransaction.count({ where }),
    ]);

    const giftIds = Array.from(new Set(rows.map((r) => r.giftId)));
    const giftsMap = new Map<string, any>();
    if (giftIds.length > 0) {
      const giftRows = await this.prisma.gift.findMany({
        where: { id: { in: giftIds } },
        select: { id: true, name: true, thumbnailUrl: true, displayName: true },
      });
      giftRows.forEach((g) => giftsMap.set(g.id, g));
    }

    const userIds = Array.from(new Set([...rows.map((r) => r.senderId), ...rows.map((r) => r.receiverId)]));
    const usersMap = new Map<string, any>();
    if (userIds.length > 0) {
      const userRows = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, fullName: true },
      });
      userRows.forEach((u) => usersMap.set(u.id, u));
    }

    const items = await Promise.all(
      rows.map(async (r) => {
        const giftInfo = giftsMap.get(r.giftId);
        const sender = usersMap.get(r.senderId);
        const receiver = usersMap.get(r.receiverId);
        return {
          ...r,
          totalCoinValue: r.totalCoinValue.toString(),
          creatorEarnings: r.creatorEarnings.toString(),
          senderName: sender?.fullName || sender?.username || 'Supporter',
          receiverName: receiver?.fullName || receiver?.username || 'Recipient',
          giftName: giftInfo?.displayName || giftInfo?.name || 'Gift',
          giftThumbnailUrl: (await this.media.resolve(giftInfo?.thumbnailUrl)) || null,
        };
      })
    );

    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'View paginated audit logs for the video room' })
  async logs(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = { roomId: id };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.roomLog.findMany({
        where,
        skip: q.skip || 0,
        take: q.limit || 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomLog.count({ where }),
    ]);

    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/bans')
  @ApiOperation({ summary: 'List active room bans' })
  async bans(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActiveBlocks(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/mutes')
  @ApiOperation({ summary: 'List active room mutes' })
  async mutes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActiveMutes(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/actions')
  @ApiOperation({ summary: 'List room moderation actions' })
  async actions(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.moderationRepository.listActions(
      id,
      q.skip || 0,
      q.limit || 20,
    );
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/moderation/reports')
  @ApiOperation({ summary: 'List room moderation reports' })
  async reports(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    const [items, total] = await this.reportRepository.list(id, {
      skip: q.skip || 0,
      take: q.limit || 20,
    });
    return buildPaginated(items, total, q.page || 1, q.limit || 20);
  }

  @Get(':id/live-session')
  @ApiOperation({ summary: 'Get comprehensive live session monitoring details for video room' })
  async getLiveSession(@Param('id', ParseUuidPipe) id: string) {
    const room = await this.prisma.videoRoom.findFirst({
      where: { id, deletedAt: null },
    });
    if (!room) {
      throw new BusinessException('Video room not found', ERROR_CODES.ROOM_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    const [
      owner,
      settings,
      seats,
      activeMembers,
      giftsAggregate,
      messagesCount,
      reportsCount,
      recentGiftsRows,
      recentMessages,
      activeGameSession,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: room.ownerId },
        select: {
          id: true,
          username: true,
          fullName: true,
          country: true,
        },
      }),
      this.prisma.videoRoomSettings.findUnique({
        where: { roomId: id },
      }),
      this.prisma.videoRoomSeat.findMany({
        where: { roomId: id },
      }),
      this.prisma.videoRoomMember.findMany({
        where: { roomId: id, isActive: true },
        orderBy: { joinedAt: 'asc' },
      }),
      this.prisma.giftTransaction.aggregate({
        _sum: { totalCoinValue: true, creatorEarnings: true },
        where: { contextId: id, contextType: 'VIDEO_ROOM' },
      }),
      this.prisma.videoRoomMessage.count({
        where: { roomId: id, deletedAt: null },
      }),
      this.prisma.videoRoomReport.count({
        where: { roomId: id },
      }),
      this.prisma.giftTransaction.findMany({
        where: { contextId: id, contextType: 'VIDEO_ROOM' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.videoRoomMessage.findMany({
        where: { roomId: id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.gameSession.findFirst({
        where: { roomId: id, status: 'ACTIVE' },
        select: { code: true, mode: true },
      }),
    ]);

    const memberUserIds = activeMembers.map((m) => m.userId);
    const giftSenderIds = recentGiftsRows.map((g) => g.senderId);
    const giftReceiverIds = recentGiftsRows.map((g) => g.receiverId);
    const allUserIds = Array.from(new Set([...memberUserIds, ...giftSenderIds, ...giftReceiverIds, room.ownerId]));

    const usersMap = new Map<string, any>();
    if (allUserIds.length > 0) {
      const [userRows, profileRows, statsRows, verificationRows] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: {
            id: true,
            username: true,
            fullName: true,
            country: true,
          },
        }),
        this.prisma.userProfile.findMany({
          where: { userId: { in: allUserIds } },
          select: {
            userId: true,
            avatarKey: true,
          },
        }),
        this.prisma.userStatistics.findMany({
          where: { userId: { in: allUserIds } },
          select: {
            userId: true,
            level: true,
            vipLevel: true,
          },
        }),
        this.prisma.userVerification.findMany({
          where: { userId: { in: allUserIds } },
          select: {
            userId: true,
            verified: true,
          },
        }),
      ]);
      const profileMap = new Map<string, string | null>();
      profileRows.forEach((p) => profileMap.set(p.userId, p.avatarKey));

      const statsMap = new Map<string, { level: number; vipLevel: number }>();
      statsRows.forEach((s) => statsMap.set(s.userId, { level: s.level, vipLevel: s.vipLevel }));

      const verificationMap = new Map<string, boolean>();
      verificationRows.forEach((v) => verificationMap.set(v.userId, v.verified));

      userRows.forEach((u) => {
        const uStats = statsMap.get(u.id);
        usersMap.set(u.id, {
          ...u,
          avatarUrl: profileMap.get(u.id) || null,
          level: uStats?.level || 1,
          vipLevel: uStats?.vipLevel || 0,
          isVerified: verificationMap.get(u.id) ?? false,
        });
      });
    }

    const occupiedSeatUserIds = new Set(
      seats.filter((s) => s.occupantUserId).map((s) => s.occupantUserId!),
    );
    const mutedSeatUserIds = new Set(
      seats.filter((s) => s.isMuted && s.occupantUserId).map((s) => s.occupantUserId!),
    );

    const totalOnlineUsers =
      activeMembers.length > 0 ? activeMembers.length : room.status === 'LIVE' ? 1 : 0;
    const activeMic =
      occupiedSeatUserIds.size > 0 ? occupiedSeatUserIds.size : room.status === 'LIVE' ? 1 : 0;
    const listeners = Math.max(0, totalOnlineUsers - activeMic);
    const giftCoins = Number(giftsAggregate._sum.totalCoinValue || 0);
    const roomRevenue =
      Number(giftsAggregate._sum.creatorEarnings || 0) || Math.round(giftCoins * 0.72);

    const ownerProfile = usersMap.get(room.ownerId);

    const participants = activeMembers.map((m) => {
      const u = usersMap.get(m.userId);
      const isOwner = m.userId === room.ownerId;
      const isMuted = mutedSeatUserIds.has(m.userId);
      const isOnMic = occupiedSeatUserIds.has(m.userId) || isOwner;
      return {
        userId: m.userId,
        username:
          u?.fullName ||
          u?.username ||
          (isOwner ? owner?.fullName || owner?.username || 'Host' : 'User'),
        avatarUrl: u?.avatarUrl || null,
        role: isOwner
          ? 'Host'
          : m.role === 'MODERATOR'
          ? 'Admin'
          : m.role === 'PARTICIPANT'
          ? 'Speaker'
          : 'Member',
        level: u?.level || 1,
        isMuted: isMuted,
        isSpeaking: isOnMic && !isMuted,
        isHost: isOwner,
        joinedAt: m.joinedAt,
      };
    });

    if (participants.length === 0 && owner) {
      participants.push({
        userId: owner.id,
        username: owner.fullName || owner.username,
        avatarUrl: ownerProfile?.avatarUrl || null,
        role: 'Host',
        level: ownerProfile?.level || 1,
        isMuted: false,
        isSpeaking: true,
        isHost: true,
        joinedAt: room.createdAt,
      });
    }

    const giftIds = Array.from(new Set(recentGiftsRows.map((g) => g.giftId)));
    const giftsMap = new Map<string, any>();
    if (giftIds.length > 0) {
      const giftRows = await this.prisma.gift.findMany({
        where: { id: { in: giftIds } },
        select: { id: true, name: true, thumbnailUrl: true, displayName: true },
      });
      giftRows.forEach((g) => giftsMap.set(g.id, g));
    }

    const recentGifts = await Promise.all(
      recentGiftsRows.map(async (g) => {
        const sender = usersMap.get(g.senderId);
        const receiver = usersMap.get(g.receiverId);
        const coins = Number(g.totalCoinValue || 0);
        const isDiamond = coins < 50;
        const giftInfo = giftsMap.get(g.giftId);
        return {
          id: g.id,
          senderId: g.senderId,
          senderName: sender?.fullName || sender?.username || 'Supporter',
          senderAvatarUrl: sender?.avatarUrl || null,
          receiverId: g.receiverId,
          receiverName: receiver?.fullName || receiver?.username || (g.receiverId === room.ownerId ? owner?.fullName || owner?.username || 'Host' : 'Recipient'),
          receiverAvatarUrl: receiver?.avatarUrl || null,
          giftName: giftInfo?.displayName || giftInfo?.name || (isDiamond ? 'Diamond' : 'Coins'),
          giftThumbnailUrl: await this.media.resolve(giftInfo?.thumbnailUrl) || null,
          currencyType: isDiamond ? 'diamonds' : 'coins',
          amount: coins || 0,
          amountFormatted: isDiamond ? `${coins} diamonds` : `${coins.toLocaleString()} coins`,
          createdAt: g.createdAt,
        };
      })
    );

    const recentChats = recentMessages.reverse().map((msg) => {
      const isSystem = msg.type === 'SYSTEM' || msg.type === 'ANNOUNCEMENT';
      const sender = usersMap.get(msg.senderId);
      return {
        id: msg.id,
        senderId: msg.senderId,
        senderName: isSystem ? 'System' : (sender?.fullName || sender?.username || 'Member'),
        senderAvatarUrl: isSystem ? null : (sender?.avatarUrl || null),
        body: msg.content,
        type: msg.type,
        createdAt: msg.createdAt,
      };
    });

    const gameName = activeGameSession
      ? String(activeGameSession.code).replace(/_/g, ' ')
      : 'None';

    return {
      sessionInfo: {
        id: room.id,
        shortId: `VR-${room.id.slice(0, 5).toUpperCase()}`,
        name: room.name,
        roomName: room.name,
        title: room.name,
        type: 'Video room',
        owner: {
          id: owner?.id || room.ownerId,
          username: owner?.username || 'Host',
          fullName: owner?.fullName || owner?.username || 'Host',
          avatarUrl: ownerProfile?.avatarUrl || null,
          isVerified: ownerProfile?.isVerified ?? false,
          level: ownerProfile?.level || 1,
        },
        roomLevel: `Level ${room.roomLevel || ownerProfile?.level || 1}`,
        createdAt: room.createdAt,
        runningGame: gameName,
        language: room.language || 'English',
        country: owner?.country || 'N/A',
        status: room.status,
        isLocked: room.isLocked,
        isSlowMode: (settings?.slowModeSeconds || 0) > 0,
        slowModeSeconds: settings?.slowModeSeconds || 0,
      },
      stats: {
        totalOnlineUsers,
        activeMic,
        listeners,
        giftCoins,
        messages: messagesCount,
        reports: reportsCount,
        shares: 0,
        roomRevenue,
        lastUpdated: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      },
      participants,
      recentGifts,
      recentChats,
    };
  }

  @Post(':id/slow-mode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle chat slow mode for video room' })
  async setSlowMode(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VideoRoomSlowModeAdminDto,
  ) {
    const seconds = dto.slowMode ? 5 : 0;
    await this.prisma.videoRoomSettings.upsert({
      where: { roomId: id },
      update: { slowModeSeconds: seconds },
      create: { roomId: id, slowModeSeconds: seconds },
    });
    return { slowMode: dto.slowMode, seconds };
  }
}
