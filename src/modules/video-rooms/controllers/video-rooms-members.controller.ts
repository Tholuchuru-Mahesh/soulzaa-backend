import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  VIDEO_ROOM_DEFAULT_PAGE_SIZE,
  VIDEO_ROOM_MAX_PAGE_SIZE,
} from '../constants/video-room.constants';
import { JoinVideoRoomDto } from '../dto/join-video-room.dto';
import { LeaveVideoRoomDto } from '../dto/leave-video-room.dto';
import { ReconnectVideoRoomDto } from '../dto/reconnect-video-room.dto';
import { VideoRoomHeartbeatDto } from '../dto/video-room-heartbeat.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomMemberService, type JoinContext } from '../services/video-room-member.service';
import { VideoRoomSessionService } from '../services/video-room-session.service';

/**
 * Video Room member/presence/session REST surface (VR-3). Command-in over REST;
 * realtime fan-out is EVENT_BUS → VideoRoomSocketListener (no domain socket
 * gateway). Global JwtAuthGuard secures every route; state-changing routes deny
 * guests (@NotGuest) and return 200. UUID room ids are validated; bodies are
 * validated against their DTOs. Business rules + RBAC live in the services.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomMembersController {
  constructor(
    private readonly members: VideoRoomMemberService,
    private readonly sessions: VideoRoomSessionService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  private joinContext(dto: JoinVideoRoomDto, user: AuthenticatedUser, ip?: string): JoinContext {
    return {
      socketId: dto.socketId,
      deviceId: dto.deviceId,
      platform: dto.platform,
      ip,
      sid: user.sid,
    };
  }

  @Post(':id/join')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a video room (returns the full room-state sync)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Joined; room-state sync payload returned.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Room not live / full.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Blocked from this room.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Incorrect room password.' })
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: JoinVideoRoomDto,
    @Ip() ip: string,
  ) {
    return this.members.join(this.actor(user), roomId, {}, this.joinContext(dto, user, ip));
  }

  @Post(':id/leave')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave a video room (graceful exit)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Left the room.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: LeaveVideoRoomDto,
    @Ip() ip: string,
  ) {
    return this.members.leave(this.actor(user), roomId, { socketId: dto.socketId }, { ip });
  }

  @Post(':id/reconnect')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconnect within the grace window (returns a fresh sync)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Reconnected; room-state sync payload returned.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Session already reclaimed — rejoin.' })
  reconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: ReconnectVideoRoomDto,
    @Ip() ip: string,
  ) {
    const ctx: JoinContext = {
      socketId: dto.socketId,
      deviceId: dto.deviceId,
      platform: dto.platform,
      ip,
      sid: user.sid,
    };
    return this.members.reconnect(
      this.actor(user),
      roomId,
      { previousSocketId: dto.previousSocketId },
      ctx,
    );
  }

  @Post(':id/heartbeat')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Session heartbeat (slides TTL; reports activity)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Heartbeat accepted (alive=true/false).' })
  async heartbeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: VideoRoomHeartbeatDto,
  ): Promise<{ alive: boolean }> {
    let alive = await this.sessions.heartbeat(dto.socketId, { inBackground: dto.inBackground });
    if (!alive && user?.id) {
      const userSession = await this.members.getMySession(user.id, roomId);
      if (userSession) {
        alive = true;
      }
    }
    return { alive };
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List active room members (paginated)' })
  members_(
    @Param('id', ParseUuidPipe) roomId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = Math.min(Number(limit) || VIDEO_ROOM_DEFAULT_PAGE_SIZE, VIDEO_ROOM_MAX_PAGE_SIZE);
    const skip = Math.max(Number(offset) || 0, 0);
    return this.members.listMembers(roomId, take, skip);
  }

  @Get(':id/presence')
  @ApiOperation({ summary: "Live presence for the room's active members" })
  presence(@Param('id', ParseUuidPipe) roomId: string) {
    return this.members.listPresence(roomId);
  }

  @Get(':id/session')
  @ApiOperation({ summary: "The caller's own live session in the room" })
  session(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.members.getMySession(user.id, roomId);
  }

  @Get(':id/sync')
  @ApiOperation({ summary: 'Synchronise room state (version-based)' })
  sync(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query('lastVersion') lastVersion?: string,
  ) {
    return this.members.sync(
      this.actor(user),
      roomId,
      lastVersion ? Number(lastVersion) : undefined,
    );
  }
}
