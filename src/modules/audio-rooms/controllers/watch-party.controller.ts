import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { SeekDto, SetVideoDto } from '../dto/premium.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { WatchPartyService } from '../services/watch-party.service';

/**
 * YouTube watch-party REST surface (base `rooms/:id/watch-party`). JWT-guarded.
 * Reads are open to participants; playback control (set/play/pause/seek/stop)
 * requires room owner/admin authority, enforced in the service. Realtime sync
 * flows through the premium socket bridge.
 */
@ApiTags('audio-room-watch-party')
@ApiBearerAuth()
@Controller('rooms')
export class WatchPartyController {
  constructor(private readonly watch: WatchPartyService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Get(':id/watch-party')
  @ApiOperation({ summary: 'Current watch-party state (drift-corrected)' })
  state(@Param('id', ParseUuidPipe) id: string) {
    return this.watch.getState(id);
  }

  @Post(':id/watch-party/video')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Set the watch-party video (owner/admin)' })
  setVideo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SetVideoDto,
  ) {
    return this.watch.setVideo(this.actor(user), id, dto.videoId);
  }

  @Post(':id/watch-party/play')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Resume playback (owner/admin)' })
  play(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.watch.play(this.actor(user), id);
  }

  @Post(':id/watch-party/pause')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pause playback (owner/admin)' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.watch.pause(this.actor(user), id);
  }

  @Post(':id/watch-party/seek')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Seek to a position (owner/admin)' })
  seek(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SeekDto,
  ) {
    return this.watch.seek(this.actor(user), id, dto.positionSeconds);
  }

  @Post(':id/watch-party/stop')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Stop the watch party (owner/admin)' })
  stop(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.watch.stop(this.actor(user), id);
  }
}
