import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { VoiceBackgroundDto } from '../dto/voice-background.dto';
import { VoiceHeartbeatDto } from '../dto/voice-heartbeat.dto';
import { VoiceJoinDto } from '../dto/voice-join.dto';
import { VoiceQualityDto } from '../dto/voice-quality.dto';
import { VoiceRouteDto } from '../dto/voice-route.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VoiceService } from '../services/voice.service';

/**
 * AR-2 voice REST surface (base `rooms/:id/voice/...`). JWT-guarded globally;
 * membership + publish privilege are enforced in the service. Token/join/
 * reconnect place a user on the ZEGO channel so they are `@NotGuest`.
 */
@ApiTags('audio-room-voice')
@ApiBearerAuth()
@Controller('rooms')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/voice/token')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Issue a ZEGOCLOUD voice token for the room' })
  token(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.voice.issueToken(this.actor(user), id);
  }

  @Post(':id/voice/join')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Join the voice channel (returns token + voice state)' })
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VoiceJoinDto,
  ) {
    return this.voice.join(this.actor(user), id, dto);
  }

  @Post(':id/voice/reconnect')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Reconnect to the voice channel after a network drop' })
  reconnect(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.voice.reconnect(this.actor(user), id);
  }

  @Post(':id/voice/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave the voice channel' })
  async leave(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.voice.leave(this.actor(user), id);
    return { left: true };
  }

  @Post(':id/voice/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Self-mute the microphone' })
  mute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.voice.setSelfMute(this.actor(user), id, true);
  }

  @Post(':id/voice/unmute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Un-self-mute the microphone' })
  unmute(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.voice.setSelfMute(this.actor(user), id, false);
  }

  @Post(':id/voice/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Voice heartbeat (liveness + speaking + quality)' })
  heartbeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VoiceHeartbeatDto,
  ) {
    return this.voice.heartbeat(this.actor(user), id, dto);
  }

  @Post(':id/voice/quality')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report voice quality metrics' })
  quality(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VoiceQualityDto,
  ) {
    return this.voice.reportQuality(this.actor(user), id, dto);
  }

  @Post(':id/voice/route')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report an audio route switch' })
  route(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VoiceRouteDto,
  ) {
    return this.voice.switchRoute(this.actor(user), id, dto);
  }

  @Post(':id/voice/background')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Report app background/foreground transition' })
  background(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: VoiceBackgroundDto,
  ) {
    return this.voice.setBackground(this.actor(user), id, dto);
  }

  @Get(':id/voice/state')
  @ApiOperation({ summary: 'Get the live voice state (participants + speaking)' })
  state(@Param('id', ParseUuidPipe) id: string) {
    return this.voice.getVoiceState(id);
  }
}
