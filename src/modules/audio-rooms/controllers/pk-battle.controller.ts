import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { InvitePkDto, StartPkDto } from '../dto/pk.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { PkBattleService } from '../services/pk-battle.service';

class PkLeaderboardDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

/**
 * PK Battle REST surface. Start/cancel (base `rooms/:id/pk`) require room
 * owner/admin authority (enforced in the service); reads (active state, history,
 * leaderboard) are open. Scores are driven by gifts, not by direct calls.
 */
@ApiTags('audio-room-pk')
@ApiBearerAuth()
@Controller()
export class PkBattleController {
  constructor(private readonly pk: PkBattleService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post('rooms/:id/pk/start')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Start a PK battle (owner/admin)' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: StartPkDto,
  ) {
    return this.pk.start(this.actor(user), id, dto);
  }

  @Post('rooms/:id/pk/invite')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Invite an opponent to a PK battle (owner/admin)' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: InvitePkDto,
  ) {
    return this.pk.invite(this.actor(user), id, dto);
  }

  @Post('rooms/:id/pk/invite/accept')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Accept a PK battle invitation' })
  acceptInvite(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.pk.acceptInvite(user.id, id);
  }

  @Post('rooms/:id/pk/invite/reject')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Reject a PK battle invitation' })
  async rejectInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.pk.rejectInvite(user.id, id);
    return { rejected: true };
  }

  @Post('rooms/:id/pk/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel the active PK battle (owner/admin)' })
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.pk.cancel(this.actor(user), id);
    return { cancelled: true };
  }

  @Get('rooms/:id/pk')
  @ApiOperation({ summary: 'Active PK battle state (live scores)' })
  active(@Param('id', ParseUuidPipe) id: string) {
    return this.pk.getActive(id);
  }

  @Get('rooms/:id/pk/history')
  @ApiOperation({ summary: 'Past PK battles in the room' })
  history(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.pk.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Get('pk/leaderboard')
  @ApiOperation({ summary: 'Global PK wins leaderboard' })
  leaderboard(@Query() q: PkLeaderboardDto) {
    return this.pk.leaderboard(q.limit);
  }
}
