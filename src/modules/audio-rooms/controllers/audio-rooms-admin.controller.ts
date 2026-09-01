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
import { IsBoolean } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { ListModerationDto } from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomsService } from '../services/audio-rooms.service';
import { ModerationService } from '../services/moderation.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

export class LockRoomAdminDto {
  @IsBoolean()
  isLocked!: boolean;
}

export class SlowModeAdminDto {
  @IsBoolean()
  slowMode!: boolean;
}

@ApiTags('audio-rooms-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/rooms')
export class AudioRoomsAdminController {
  constructor(
    private readonly rooms: AudioRoomsService,
    private readonly moderation: ModerationService,
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete/disband a room permanently' })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.remove(this.actor(user), id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End the active room live session' })
  async end(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.rooms.end(this.actor(user), id);
    return { ended: true };
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock or unlock a room' })
  async lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockRoomAdminDto,
  ) {
    return this.rooms.setLock(this.actor(user), id, dto.isLocked);
  }

  @Post(':id/remove-owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove the room owner — promote the highest-ranking member, or close the room',
  })
  async removeOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.rooms.removeOwner(this.actor(user), id);
    return { ownerRemoved: true };
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List active members/participants of the room' })
  async members(@Param('id', ParseUuidPipe) id: string) {
    const detail = await this.rooms.getRoomDetail(id);
    return detail.participants;
  }

  @Get(':id/gifts')
  @ApiOperation({ summary: 'View paginated gift transactions for the room' })
  async gifts(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = {
      contextId: id,
      contextType: 'AUDIO_ROOM' as const,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.giftTransaction.findMany({
        where,
        skip: q.skip,
        take: q.limit,
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

    const userIds = Array.from(
      new Set([...rows.map((r) => r.senderId), ...rows.map((r) => r.receiverId)]),
    );
    const usersMap = new Map<string, any>();
    if (userIds.length > 0) {
      const userRows = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, fullName: true },
      });
      userRows.forEach((u) => usersMap.set(u.id, u));
    }

    // Format BigInts to string and attach gift & user info
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
      }),
    );

    return buildPaginated(items, total, q.page, q.limit);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'View paginated audit logs for the room' })
  async logs(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    const where = { roomId: id };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.roomLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.roomLog.count({ where }),
    ]);

    return buildPaginated(items, total, q.page, q.limit);
  }

  // ---- Room Moderation Delegations ----

  @Get(':id/moderation/bans')
  @ApiOperation({ summary: 'List active room bans' })
  bans(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listBans(id, q);
  }

  @Get(':id/moderation/mutes')
  @ApiOperation({ summary: 'List active room mutes' })
  mutes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listMutes(id, q);
  }

  @Get(':id/moderation/actions')
  @ApiOperation({ summary: 'List room moderation actions' })
  actions(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listActions(id, q);
  }

  @Get(':id/moderation/reports')
  @ApiOperation({ summary: 'List room moderation reports' })
  reports(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listReports(id, q);
  }

  @Get(':id/moderation/appeals')
  @ApiOperation({ summary: 'List room moderation appeals' })
  appeals(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listAppeals(id, q);
  }

  @Get(':id/live-session')
  @ApiOperation({ summary: 'Get comprehensive live session monitoring details for superadmin' })
  async getLiveSession(@Param('id', ParseUuidPipe) id: string) {
    const room = await this.prisma.audioRoom.findUnique({
      where: { id },
    });
    if (!room) {
      throw new BusinessException(
        'Room not found',
        ERROR_CODES.ROOM_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
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
      this.prisma.roomSettings.findUnique({
        where: { roomId: id },
      }),
      this.prisma.roomSeat.findMany({
        where: { roomId: id },
      }),
      this.prisma.roomMember.findMany({
        where: { roomId: id, isActive: true },
        orderBy: { joinedAt: 'asc' },
      }),
      this.prisma.giftTransaction.aggregate({
        _sum: { totalCoinValue: true, creatorEarnings: true },
        where: { contextId: id, contextType: 'AUDIO_ROOM' },
      }),
      this.prisma.roomMessage.count({
        where: { roomId: id, isDeleted: false },
      }),
      this.prisma.roomReport.count({
        where: { roomId: id },
      }),
      this.prisma.giftTransaction.findMany({
        where: { contextId: id, contextType: 'AUDIO_ROOM' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.roomMessage.findMany({
        where: { roomId: id, isDeleted: false },
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
    const allUserIds = Array.from(
      new Set([...memberUserIds, ...giftSenderIds, ...giftReceiverIds, room.ownerId]),
    );

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
            wealthLevel: true,
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
      statsRows.forEach((s) => statsMap.set(s.userId, { level: s.level, vipLevel: s.wealthLevel }));

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
          : m.role === 'ADMIN'
            ? 'Admin'
            : m.role === 'SPEAKER'
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
          receiverName:
            receiver?.fullName ||
            receiver?.username ||
            (g.receiverId === room.ownerId
              ? owner?.fullName || owner?.username || 'Host'
              : 'Recipient'),
          receiverAvatarUrl: receiver?.avatarUrl || null,
          giftName: giftInfo?.displayName || giftInfo?.name || (isDiamond ? 'Diamond' : 'Coins'),
          giftThumbnailUrl: (await this.media.resolve(giftInfo?.thumbnailUrl)) || null,
          currencyType: isDiamond ? 'diamonds' : 'coins',
          amount: coins || 0,
          amountFormatted: isDiamond ? `${coins} diamonds` : `${coins.toLocaleString()} coins`,
          createdAt: g.createdAt,
        };
      }),
    );

    const recentChats = recentMessages.reverse().map((msg) => {
      const isSystem = msg.type === 'SYSTEM' || msg.type === 'ANNOUNCEMENT';
      const sender = usersMap.get(msg.senderId);
      return {
        id: msg.id,
        senderId: msg.senderId,
        senderName: isSystem ? 'System' : sender?.fullName || sender?.username || 'Member',
        senderAvatarUrl: isSystem ? null : sender?.avatarUrl || null,
        body: msg.content,
        type: msg.type,
        createdAt: msg.createdAt,
      };
    });

    const gameName = activeGameSession ? String(activeGameSession.code).replace(/_/g, ' ') : 'None';

    return {
      sessionInfo: {
        id: room.id,
        shortId: `AR-${room.id.slice(0, 5).toUpperCase()}`,
        name: room.name,
        roomName: room.name,
        title: room.name,
        type: 'Audio room',
        owner: {
          id: owner?.id || room.ownerId,
          username: owner?.username || 'Host',
          fullName: owner?.fullName || owner?.username || 'Host',
          avatarUrl: ownerProfile?.avatarUrl || null,
          isVerified: ownerProfile?.isVerified ?? false,
          level: ownerProfile?.level || 1,
        },
        roomLevel: `Level ${ownerProfile?.level || 1}`,
        createdAt: room.createdAt,
        runningGame: gameName,
        language: room.language || 'English',
        country: owner?.country || 'N/A',
        status: room.status,
        isLocked: room.isLocked,
        isSlowMode: (settings?.chatSlowModeSeconds || 0) > 0,
        slowModeSeconds: settings?.chatSlowModeSeconds || 0,
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
  @ApiOperation({ summary: 'Toggle chat slow mode for audio room' })
  async setSlowMode(@Param('id', ParseUuidPipe) id: string, @Body() dto: SlowModeAdminDto) {
    const seconds = dto.slowMode ? 5 : 0;
    await this.prisma.roomSettings.upsert({
      where: { roomId: id },
      update: { chatSlowModeSeconds: seconds },
      create: { roomId: id, chatSlowModeSeconds: seconds },
    });
    return { slowMode: dto.slowMode, seconds };
  }
}
