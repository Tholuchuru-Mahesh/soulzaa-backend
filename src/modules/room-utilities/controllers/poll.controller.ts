import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { CreatePollDto, VotePollDto } from '../dto/room-utilities.dto';
import { PollService } from '../services/poll.service';

/**
 * Room poll REST surface (base `rooms/:id/polls`). Creating/ending a poll needs
 * owner/admin authority (enforced in the service); voting is open to any active
 * member. Reads expose the active polls, a single poll, and room history.
 */
@ApiTags('room-utilities')
@ApiBearerAuth()
@Controller('rooms')
export class PollController {
  constructor(private readonly polls: PollService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/polls')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Create a poll (owner/admin)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreatePollDto,
  ) {
    return this.polls.create(this.actor(user), id, dto);
  }

  @Post(':id/polls/:pollId/vote')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cast a vote in a poll' })
  vote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('pollId', ParseUuidPipe) pollId: string,
    @Body() dto: VotePollDto,
  ) {
    return this.polls.vote(this.actor(user), id, pollId, dto.optionId);
  }

  @Post(':id/polls/:pollId/end')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'End a poll (owner/admin)' })
  end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('pollId', ParseUuidPipe) pollId: string,
  ) {
    return this.polls.end(this.actor(user), id, pollId);
  }

  @Get(':id/polls/active')
  @ApiOperation({ summary: 'Active polls in the room (connection recovery)' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.polls.getActive(id);
  }

  @Get(':id/polls/history')
  @ApiOperation({ summary: 'Past polls in the room' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.polls.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get(':id/polls/:pollId')
  @ApiOperation({ summary: 'A single poll with live tallies' })
  getOne(@Param('id', ParseUuidPipe) id: string, @Param('pollId', ParseUuidPipe) pollId: string) {
    return this.polls.getPoll(id, pollId);
  }
}
