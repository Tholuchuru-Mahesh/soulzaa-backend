import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AudioOutputDto,
  BeautySettingsDto,
  CameraSwitchDto,
  ForceMuteDto,
  JoinMediaDto,
  MediaHeartbeatDto,
  PublishStreamDto,
  RecoverMediaDto,
  SetQualityDto,
  SubscribeStreamDto,
  UnsubscribeStreamDto,
} from '../dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomMediaRecoveryService } from '../services/video-room-media-recovery.service';
import { VideoRoomMediaService } from '../services/video-room-media.service';

/**
 * Video Room media (RTC) REST surface (VR-5). Command-in over REST; realtime fan-out is
 * EVENT_BUS driven (no domain socket gateway here). The global JwtAuthGuard secures every
 * route; state-changing routes deny guests (@NotGuest). In-room RBAC + validation live in
 * the services — the controller only marshals the actor, room id, DTO, and client IP.
 */
@ApiTags('video-room-media')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsMediaController {
  constructor(
    private readonly media: VideoRoomMediaService,
    private readonly recovery: VideoRoomMediaRecoveryService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/media/join')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Join the room media session and receive a ZEGO token.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media session + stage.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Not a room member.' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Media provider not configured.',
  })
  join(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: JoinMediaDto,
    @Ip() ip: string,
  ) {
    return this.media.joinMedia(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/leave')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave the room media session.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media session ended.' })
  leave(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.leaveMedia(this.actor(user), id, ip);
  }

  @Post(':id/media/refresh')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh (re-issue) the media token.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Refreshed media token.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'No active media session.' })
  refresh(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.refreshToken(this.actor(user), id);
  }

  @Post(':id/media/publish')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start publishing (seat occupancy required).' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Publishing started.' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Already publishing / illegal transition.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'No seat occupied.' })
  publish(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PublishStreamDto,
    @Ip() ip: string,
  ) {
    return this.media.startPublish(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/stop')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop publishing.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Publishing stopped.' })
  stop(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.stopPublish(this.actor(user), id, ip);
  }

  @Post(':id/media/pause')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause the publishing stream.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Stream paused.' })
  pause(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.pausePublish(this.actor(user), id);
  }

  @Post(':id/media/resume')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume the paused stream.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Stream resumed.' })
  resume(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.resumePublish(this.actor(user), id);
  }

  @Post(':id/media/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Subscribe to a publisher.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Subscribed.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Target not publishing / limit hit.' })
  subscribe(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribeStreamDto,
    @Ip() ip: string,
  ) {
    return this.media.subscribe(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unsubscribe from a publisher.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Unsubscribed.' })
  unsubscribe(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UnsubscribeStreamDto,
    @Ip() ip: string,
  ) {
    return this.media.unsubscribe(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/camera/on')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn the camera on.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Camera on.' })
  cameraOn(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.cameraOn(this.actor(user), id, ip);
  }

  @Post(':id/media/camera/off')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn the camera off.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Camera off.' })
  cameraOff(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.cameraOff(this.actor(user), id, ip);
  }

  @Post(':id/media/camera/switch')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Switch front/rear camera.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Camera switched.' })
  switchCamera(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CameraSwitchDto,
    @Ip() ip: string,
  ) {
    return this.media.switchCamera(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/mic/on')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute the microphone.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Microphone on.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Muted by a moderator.' })
  micOn(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.micOn(this.actor(user), id, ip);
  }

  @Post(':id/media/mic/off')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute the microphone.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Microphone off.' })
  micOff(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.media.micOff(this.actor(user), id, ip);
  }

  @Post(':id/media/mic/force')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force-mute/unmute a participant (moderator).' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Force-mute applied.' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Requires MANAGE_PARTICIPANTS + outrank.',
  })
  forceMute(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ForceMuteDto,
    @Ip() ip: string,
  ) {
    return this.media.forceMute(this.actor(user), id, dto, ip);
  }

  @Post(':id/media/audio-output')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the audio output route.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Audio output updated.' })
  audioOutput(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AudioOutputDto,
  ) {
    return this.media.setAudioOutput(this.actor(user), id, dto);
  }

  @Post(':id/media/quality')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the video quality profile.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Quality updated.' })
  quality(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetQualityDto,
  ) {
    return this.media.setQuality(this.actor(user), id, dto);
  }

  @Post(':id/media/beauty')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update beauty-filter settings.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Beauty settings updated.' })
  beauty(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BeautySettingsDto,
  ) {
    return this.media.setBeauty(this.actor(user), id, dto);
  }

  @Post(':id/media/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Media heartbeat + quality sample.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Heartbeat recorded.' })
  heartbeat(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MediaHeartbeatDto,
  ) {
    return this.media.heartbeat(this.actor(user), id, dto);
  }

  @Post(':id/media/recover')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recover a media session after a network drop.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Media session + stage recovered.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Nothing to recover.' })
  recover(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RecoverMediaDto,
  ) {
    return this.recovery.recover(this.actor(user), id, dto);
  }

  @Get(':id/media/state')
  @ApiOperation({ summary: 'Get the current media stage.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'The media stage.' })
  state(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.getMediaState(this.actor(user), id);
  }
}
