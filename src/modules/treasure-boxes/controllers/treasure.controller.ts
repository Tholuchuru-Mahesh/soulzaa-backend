import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { RocketService } from '../services/rocket.service';
import { TreasureService } from '../services/treasure.service';

/**
 * Treasure box & rocket REST surface (base `rooms/:id/treasure` + `.../rocket`).
 * JWT-guarded globally. Starting/cancelling a treasure session requires room
 * owner/admin authority (enforced in the service); progress is driven by gifts,
 * not by direct calls. Reads expose live status, history and rewards.
 */
@ApiTags('treasure-boxes')
@ApiBearerAuth()
@Controller('rooms')
export class TreasureController {
  constructor(
    private readonly treasure: TreasureService,
    private readonly rocket: RocketService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/treasure/start')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Start a treasure session (owner/admin)' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.treasure.startSession(this.actor(user), id);
  }

  @Post(':id/treasure/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel the active treasure session (owner/admin)' })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.treasure.cancelSession(this.actor(user), id);
    return { cancelled: true };
  }

  @Get(':id/treasure/status')
  @ApiOperation({ summary: 'Live treasure session status (boxes + progress)' })
  status(@Param('id', ParseUuidPipe) id: string) {
    return this.treasure.status(id);
  }

  @Get(':id/treasure/history')
  @ApiOperation({ summary: 'Past treasure sessions in the room' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.treasure.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get(':id/treasure/rewards')
  @ApiOperation({ summary: 'Treasure reward distribution log for the room' })
  rewards(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.treasure.rewards(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get(':id/treasure/champions')
  @ApiOperation({
    summary: 'Treasure Champions - Top Contributors history for all completed boxes',
  })
  champions(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.treasure.champions(id, user.id);
  }

  @Get(':id/rocket/history')
  @ApiOperation({ summary: 'Rocket events in the room' })
  rocketHistory(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.rocket.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }
}
