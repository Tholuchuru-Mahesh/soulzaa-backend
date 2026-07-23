import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { SystemNotificationDto } from '../dto/video-room-notification.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomNotificationMuteService } from '../services/video-room-notification-mute.service';
import { VideoRoomSystemNotificationService } from '../services/video-room-system-notification.service';

/**
 * Per-room notification mute + system-notification broadcast (VR-15). Global
 * JwtAuthGuard secures every route; all generic notification/preference/device
 * endpoints are served by the existing NotificationController / DeviceController
 * — this controller adds ONLY per-room mute and the owner/admin/mod SYSTEM
 * broadcast.
 */
@ApiTags('video-rooms')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsNotificationController {
  constructor(
    private readonly muteService: VideoRoomNotificationMuteService,
    private readonly system: VideoRoomSystemNotificationService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/notifications/mute')
  @NotGuest()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Mute notifications for this video room' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Room muted for the current user.' })
  async mute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<void> {
    await this.muteService.mute(user.id, roomId);
  }

  @Delete(':id/notifications/mute')
  @NotGuest()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Unmute notifications for this video room' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Room unmuted for the current user.' })
  async unmute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<void> {
    await this.muteService.unmute(user.id, roomId);
  }

  @Get(':id/notifications/mute')
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Whether the current user muted this video room' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Mute status.' })
  async status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
  ): Promise<{ roomId: string; muted: boolean }> {
    const muted = await this.muteService.listMuted(user.id);
    return { roomId, muted: muted.includes(roomId) };
  }

  @Post(':id/notifications/system')
  @NotGuest()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: 'id', description: 'Video room id' })
  @ApiOperation({ summary: 'Broadcast a system notification to the room (owner/admin/mod)' })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: 'System notification queued for room members.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Caller lacks MANAGE_ANNOUNCEMENTS.' })
  async broadcastSystem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: SystemNotificationDto,
  ): Promise<{ queued: true }> {
    await this.system.broadcast(this.actor(user), roomId, dto);
    return { queued: true };
  }
}
