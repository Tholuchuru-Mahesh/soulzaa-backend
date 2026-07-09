import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateLobbyDto,
  GameLeaderboardDto,
  ListSessionsDto,
  SettleResultDto,
} from '../dto/games.dto';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesService } from '../services/games.service';

/**
 * Games platform REST surface (base `games`). Catalog + leaderboard are open;
 * lobby/stake actions require a registered (non-guest) account; result
 * submission is a trusted seam restricted to platform ADMIN/SUPER_ADMIN (a game
 * engine authenticates as a trusted role) — it validates and pays out but never
 * decides the winner.
 */
@ApiTags('games')
@ApiBearerAuth()
@Controller('games')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  private actor(user: AuthenticatedUser): GameActor {
    return { id: user.id, roles: user.roles };
  }

  @Get()
  @ApiOperation({ summary: 'List the enabled game catalog' })
  catalog() {
    return this.games.listCatalog();
  }

  @Post('lobbies')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Create a game lobby' })
  createLobby(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLobbyDto) {
    return this.games.createLobby(this.actor(user), dto);
  }

  @Get('lobbies')
  @ApiOperation({ summary: 'List open lobbies' })
  openLobbies(@Query() q: PaginationQueryDto) {
    return this.games.listOpenLobbies(q.page, q.limit, q.skip);
  }

  @Get('lobbies/:code')
  @ApiOperation({ summary: 'Lobby detail by join code' })
  lobby(@Param('code') code: string) {
    return this.games.getLobby(code);
  }

  @Post('lobbies/:code/join')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Join a lobby by code' })
  join(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.games.joinLobby(this.actor(user), code);
  }

  @Post('lobbies/:code/leave')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Leave a lobby (host leaving disbands it)' })
  leave(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.games.leaveLobby(this.actor(user), code);
  }

  @Post('lobbies/:code/start')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Start the match (host only) — escrows every stake' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.games.startLobby(this.actor(user), code);
  }

  @Get('sessions/:id')
  @ApiOperation({ summary: 'Session detail' })
  session(@Param('id', ParseUuidPipe) id: string) {
    return this.games.getSession(id);
  }

  @Post('sessions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel an active session (host/admin) — refunds stakes' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.cancelSession(this.actor(user), id);
  }

  @Post('sessions/:id/result')
  @HttpCode(HttpStatus.OK)
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Submit a match result (trusted) — validates & pays out' })
  settle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SettleResultDto,
  ) {
    return this.games.settleResult({
      sessionId: id,
      winners: dto.winners,
      payouts: dto.payouts,
      resultData: dto.resultData,
      settledBy: user.id,
    });
  }

  @Get('history')
  @NotGuest()
  @ApiOperation({ summary: 'My match history' })
  history(@CurrentUser() user: AuthenticatedUser, @Query() q: ListSessionsDto) {
    return this.games.history(this.actor(user), q);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Global game wins leaderboard' })
  leaderboard(@Query() q: GameLeaderboardDto) {
    return this.games.leaderboard(q.limit);
  }
}
