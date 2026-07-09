import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { StartCountdownDto } from '../dto/room-utilities.dto';
import { CountdownService } from '../services/countdown.service';
import { RoomUtilitiesService } from '../services/room-utilities.service';

/**
 * Countdown timer + aggregate-state REST surface (base `rooms/:id/countdown` and
 * `rooms/:id/room-utilities`). Start/pause/resume/cancel require owner/admin
 * authority (enforced in the service). Reads are open to any participant for
 * connection recovery.
 */
@ApiTags('room-utilities')
@ApiBearerAuth()
@Controller('rooms')
export class CountdownController {
  constructor(
    private readonly countdown: CountdownService,
    private readonly utilities: RoomUtilitiesService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/countdown/start')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Start a countdown (owner/admin)' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: StartCountdownDto,
  ) {
    return this.countdown.start(this.actor(user), id, dto);
  }

  @Post(':id/countdown/pause')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pause the active countdown (owner/admin)' })
  pause(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.countdown.pause(this.actor(user), id);
  }

  @Post(':id/countdown/resume')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Resume the paused countdown (owner/admin)' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.countdown.resume(this.actor(user), id);
  }

  @Post(':id/countdown/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel the active countdown (owner/admin)' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.countdown.cancel(this.actor(user), id);
  }

  @Get(':id/countdown/active')
  @ApiOperation({ summary: 'The active countdown, if any (connection recovery)' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.countdown.getActive(id);
  }

  @Get(':id/room-utilities/state')
  @ApiOperation({ summary: 'Aggregate live utility state (poll + countdown + wheels)' })
  state(@Param('id', ParseUuidPipe) id: string) {
    return this.utilities.getActiveState(id);
  }
}
