import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { PremiumSeatService } from '../services/premium-seat.service';

/**
 * Premium Paid Admin Seat REST surface (base `rooms/:id/premium-seat`).
 * JWT-guarded. Purchasing requires a full account + membership; the service
 * enforces availability, balance and elevation checks. Revoke requires
 * moderator authority.
 */
@ApiTags('audio-room-premium-seat')
@ApiBearerAuth()
@Controller('rooms')
export class PremiumSeatController {
  constructor(private readonly premium: PremiumSeatService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/premium-seat/purchase')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Buy a premium admin seat (gold, time-limited)' })
  purchase(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.premium.purchase(this.actor(user), id);
  }

  @Get(':id/premium-seat')
  @ApiOperation({ summary: 'Active premium admin seats in the room' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.premium.listActive(id);
  }

  @Post(':id/premium-seat/:userId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a premium admin seat (moderator)' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.premium.revoke(this.actor(user), id, userId);
    return { revoked: true };
  }

  @Get('premium-seat/mine')
  @ApiOperation({ summary: 'My premium admin seat purchases' })
  mine(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.premium.mySeats(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }
}
