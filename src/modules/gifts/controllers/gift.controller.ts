import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { GiftHistoryDto, LeaderboardQueryDto, ListGiftsDto, SendGiftDto } from '../dto/gift.dto';
import { GiftCatalogService } from '../services/gift-catalog.service';
import { GiftLeaderboardService } from '../services/gift-leaderboard.service';
import { GiftService } from '../services/gift.service';

/**
 * Gifting REST surface (base `gifts`). JWT-guarded globally. Sending requires a
 * full (non-guest) account; the send flow enforces membership, balance, rate
 * limiting and idempotency in the service. Realtime fan-out into the room
 * happens via the gift event bridge in the audio-rooms module.
 */
@ApiTags('gifts')
@ApiBearerAuth()
@Controller('gifts')
export class GiftController {
  constructor(
    private readonly gifts: GiftService,
    private readonly catalog: GiftCatalogService,
    private readonly leaderboards: GiftLeaderboardService,
  ) {}

  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Send a gift within a context (e.g. an audio room)' })
  send(@CurrentUser() user: AuthenticatedUser, @Body() dto: SendGiftDto) {
    return this.gifts.sendGift({ id: user.id, roles: user.roles }, dto);
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Active gift catalog' })
  catalogList(@Query() q: ListGiftsDto) {
    return this.catalog.listCatalog(q);
  }

  @Get('history')
  @ApiOperation({ summary: 'A user’s gift history (sent + received)' })
  history(@CurrentUser('id') userId: string, @Query() q: GiftHistoryDto) {
    return this.gifts.history(userId, q);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Top gifters / receivers (daily/weekly/monthly/all-time)' })
  leaderboard(@Query() q: LeaderboardQueryDto) {
    return this.leaderboards.top({
      board: q.board,
      scope: q.scope,
      contextId: q.contextId,
      period: q.period,
      limit: q.limit,
    });
  }
}
