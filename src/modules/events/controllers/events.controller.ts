import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { EventsService } from '../services/events.service';

/**
 * Events REST surface (base `events`). JWT-guarded. Lists active public events
 * (with per-user claim state) and lets a user claim a reward event once.
 */
@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOperation({ summary: 'Active public events (with my claim state)' })
  list(@CurrentUser('id') userId: string) {
    return this.events.listActive(userId);
  }

  @Get('claims')
  @ApiOperation({ summary: 'My event claim history' })
  claims(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.events.myClaims(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Claim a reward event' })
  claim(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.events.claim(userId, id);
  }
}
