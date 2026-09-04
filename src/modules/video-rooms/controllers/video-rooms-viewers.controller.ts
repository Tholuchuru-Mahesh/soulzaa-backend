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
import {
  DemoteViewerDto,
  JoinViewerDto,
  LeaveViewerDto,
  PromoteViewerDto,
  ReconnectViewerDto,
  ViewerHeartbeatDto,
} from '../dto/viewer.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import type { JoinContext } from '../services/video-room-member.service';
import { VideoRoomViewerQueryService } from '../services/video-room-viewer-query.service';
import { VideoRoomViewerService } from '../services/video-room-viewer.service';

/**
 * Video Room viewer-mode REST surface (VR-6). A viewer IS a member with the
 * default VIEWER role, so join/leave/reconnect/heartbeat delegate to
 * VideoRoomViewerService — a thin facade over the VR-3 member/session
 * services that adds the viewer event vocabulary and host-driven
 * promote/demote. Audience reads delegate to VideoRoomViewerQueryService.
 * Global JwtAuthGuard secures every route; state-changing routes deny
 * guests (@NotGuest) and return 200. Business rules + RBAC live in the
 * services, not here.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomViewersController {
  constructor(
    private readonly viewer: VideoRoomViewerService,
    private readonly query: VideoRoomViewerQueryService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  private joinContext(dto: JoinViewerDto, user: AuthenticatedUser, ip?: string): JoinContext {
    return {
      socketId: dto.socketId,
      deviceId: dto.deviceId,
      platform: dto.platform,
      ip,
      sid: user.sid,
    };
  }

  @Post(':id/viewer/join')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join a video room as a viewer (returns the full room-state sync)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Joined; room-state sync payload returned.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Room not live / full.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Blocked from this room.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Incorrect room password.' })
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: JoinViewerDto,
    @Ip() ip: string,
  ) {
    return this.viewer.joinAsViewer(this.actor(user), roomId, {}, this.joinContext(dto, user, ip));
  }

  @Post(':id/viewer/leave')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave a video room as a viewer (graceful exit)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Left the room.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: LeaveViewerDto,
    @Ip() ip: string,
  ) {
    return this.viewer.leaveAsViewer(this.actor(user), roomId, { socketId: dto.socketId }, { ip });
  }

  @Post(':id/viewer/reconnect')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconnect as a viewer within the grace window (returns a fresh sync)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Reconnected; room-state sync payload returned.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Session already reclaimed — rejoin.' })
  reconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: ReconnectViewerDto,
    @Ip() ip: string,
  ) {
    const ctx: JoinContext = {
      socketId: dto.socketId,
      deviceId: dto.deviceId,
      platform: dto.platform,
      ip,
      sid: user.sid,
    };
    return this.viewer.reconnectViewer(
      this.actor(user),
      roomId,
      { previousSocketId: dto.previousSocketId },
      ctx,
    );
  }

  @Post(':id/viewer/heartbeat')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Viewer session heartbeat (slides TTL; reports activity)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Heartbeat accepted (alive=true/false).' })
  heartbeat(
    @Param('id', ParseUuidPipe) _roomId: string,
    @Body() dto: ViewerHeartbeatDto,
  ): Promise<{ alive: boolean }> {
    return this.viewer.heartbeat({ socketId: dto.socketId, inBackground: dto.inBackground });
  }

  @Post(':id/viewer/promote')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force-seat a viewer onto the stage (host-driven)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Promoted onto the seat.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Room not live, or target is not a viewer.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Caller lacks MANAGE_SEATS.' })
  promote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: PromoteViewerDto,
    @Ip() ip: string,
  ) {
    return this.viewer.promote(this.actor(user), roomId, dto, ip);
  }

  @Post(':id/viewer/demote')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Return a seated participant to the audience',
    description:
      'Demoting SOMEONE ELSE requires MANAGE_PARTICIPANTS and outranking the target. ' +
      'Demoting YOURSELF (`targetUserId` = caller) is always allowed — stepping down from ' +
      'your own seat is not a moderation action — except from the protected owner seat.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Demoted to the audience.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Room not live, target holds no seat, or the target holds the owner seat.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller lacks MANAGE_PARTICIPANTS / outranks (never raised for self-demote).',
  })
  demote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: DemoteViewerDto,
    @Ip() ip: string,
  ) {
    return this.viewer.demote(this.actor(user), roomId, dto, ip);
  }

  @Get(':id/viewers')
  @ApiOperation({ summary: 'List the room audience (paginated)' })
  viewers(
    @Param('id', ParseUuidPipe) roomId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const take = Math.min(Number(limit) || VIDEO_ROOM_DEFAULT_PAGE_SIZE, VIDEO_ROOM_MAX_PAGE_SIZE);
    const skip = Math.max(Number(offset) || 0, 0);
    return this.query.listAudience(roomId, take, skip);
  }

  @Get(':id/viewers/count')
  @ApiOperation({
    summary: 'Audience count breakdown (audience/watching/background/reconnecting)',
  })
  viewersCount(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.countAudience(roomId);
  }

  @Get(':id/viewer/me')
  @ApiOperation({ summary: "The caller's own viewer status in the room" })
  me(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.query.getMyViewer(user.id, roomId);
  }
}
