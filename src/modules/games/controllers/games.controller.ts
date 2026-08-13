import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AddBotDto,
  CreateLobbyDto,
  GameLeaderboardDto,
  JoinLobbyDto,
  JoinQueueDto,
  KickMemberDto,
  ListSessionsDto,
  ReportMatchResultDto,
  SetPlayerTeamDto,
  SetReadyDto,
  SettleResultDto,
  SubmitMoveDto,
  UpdateLobbySettingsDto,
} from '../dto/games.dto';
import type { GameActor } from '../interfaces/game-actor.interface';
import { GamesService } from '../services/games.service';

/**
 * Games platform REST surface (base `games`). Catalog, open-lobby listing and
 * the leaderboard are open; lobby/stake/session actions require a registered
 * (non-guest) account, and session detail/live-state additionally require the
 * caller to be a participant (or admin) of that specific session; result
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

  @Get('me/active-match')
  @NotGuest()
  @ApiOperation({
    summary:
      'Resume-on-launch: an in-progress session, an unseen completed result, or an ' +
      'open lobby the caller should be routed back into right now, if any',
  })
  myActiveMatch(@CurrentUser() user: AuthenticatedUser) {
    return this.games.getMyActiveMatch(this.actor(user));
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
  @ApiOperation({ summary: 'Join a lobby by code (with optional password)' })
  join(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: JoinLobbyDto,
  ) {
    return this.games.joinLobby(this.actor(user), code, dto.password);
  }

  @Post('lobbies/:code/kick')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Kick a member (host only)' })
  kick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: KickMemberDto,
  ) {
    return this.games.kickMember(this.actor(user), code, dto.userId);
  }

  @Post('lobbies/:code/close')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Close (disband) the lobby (host only)' })
  close(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.games.closeLobby(this.actor(user), code);
  }

  @Post('lobbies/:code/settings')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Edit open-lobby settings: stake / maxPlayers / password (host only)' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: UpdateLobbySettingsDto,
  ) {
    return this.games.updateLobbySettings(this.actor(user), code, dto);
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

  @Post('lobbies/:code/bots')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Add a bot to the lobby (host only)' })
  addBot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: AddBotDto,
  ) {
    return this.games.addBot(this.actor(user), code, { name: dto.name, team: dto.team });
  }

  @Post('lobbies/:code/team')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pick your team in a 2v2 lobby' })
  setTeam(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: SetPlayerTeamDto,
  ) {
    return this.games.setPlayerTeam(this.actor(user), code, dto.team);
  }

  @Post('lobbies/:code/ready')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Toggle ready state in a lobby' })
  setReady(
    @CurrentUser() user: AuthenticatedUser,
    @Param('code') code: string,
    @Body() dto: SetReadyDto,
  ) {
    return this.games.setLobbyReady(this.actor(user), code, dto.isReady);
  }

  // ---- Matchmaking (auto-pair queue + all-ready ready-check) ----

  @Post('matchmaking/queue')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Join the matchmaking queue (DUEL or TEAM_2V2)' })
  joinQueue(@CurrentUser() user: AuthenticatedUser, @Body() dto: JoinQueueDto) {
    return this.games.joinQueue(this.actor(user), {
      gameCode: dto.gameCode,
      stake: dto.stake,
      matchType: dto.matchType,
    });
  }

  @Post('matchmaking/leave')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Leave the matchmaking queue' })
  leaveQueue(@CurrentUser() user: AuthenticatedUser) {
    return this.games.leaveQueue(this.actor(user));
  }

  @Get('matchmaking/status')
  @NotGuest()
  @ApiOperation({ summary: 'My current matchmaking state (queued / ready-check / idle)' })
  matchmakingStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.games.getMatchmakingStatus(this.actor(user));
  }

  @Post('matchmaking/:matchId/accept')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Ready up for a found match — starts once all accept' })
  acceptMatch(@CurrentUser() user: AuthenticatedUser, @Param('matchId') matchId: string) {
    return this.games.acceptMatch(this.actor(user), matchId);
  }

  @Post('matchmaking/:matchId/decline')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Decline a found match — dissolves the ready-check' })
  declineMatch(@CurrentUser() user: AuthenticatedUser, @Param('matchId') matchId: string) {
    return this.games.declineMatch(this.actor(user), matchId);
  }

  @Get('sessions/:id')
  @NotGuest()
  @ApiOperation({ summary: 'Session detail (participants or admins only)' })
  session(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.getSession(this.actor(user), id);
  }

  @Post('sessions/:id/ack-result')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary:
      "Acknowledge this session's result — call once the Match Result screen is " +
      'dismissed, so it stops being auto-resurfaced by GET games/me/active-match',
  })
  ackResult(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.ackResult(this.actor(user), id);
  }

  @Post('sessions/:id/moves')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Relay a board-game move to the session (peer-relay)' })
  submitMove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SubmitMoveDto,
  ) {
    return this.games.relayMove(this.actor(user), id, dto.moveData, dto.onBehalfOf);
  }

  @Get('sessions/:id/live')
  @NotGuest()
  @ApiOperation({
    summary: 'Live board state (move log + turn) for reconnect/restore (participants or admins only)',
  })
  liveState(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.getLiveState(this.actor(user), id);
  }

  @Post('sessions/:id/report-result')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary:
      'Host reports the winner — held pending another participant\'s confirmation ' +
      '(or auto-confirms if undisputed) before it settles from the escrowed pot',
  })
  reportResult(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ReportMatchResultDto,
  ) {
    return this.games.reportMatchResult(this.actor(user), id, {
      winners: dto.winners,
      winningTeam: dto.winningTeam,
      resultData: dto.resultData,
    });
  }

  @Post('sessions/:id/confirm-result')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Corroborate the pending reported result — settles from the escrowed pot' })
  confirmResult(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.confirmMatchResult(this.actor(user), id);
  }

  @Post('sessions/:id/dispute-result')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Dispute the pending reported result — withholds settlement for admin review' })
  disputeResult(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.disputeMatchResult(this.actor(user), id);
  }

  @Post('sessions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Cancel an active session (host/admin) — refunds stakes' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.cancelSession(this.actor(user), id);
  }

  @Post('sessions/:id/forfeit')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Forfeit/leave a match — sole survivor takes the pot' })
  forfeit(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.games.forfeit(this.actor(user), id);
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

  @Get('lucky-records')
  @NotGuest()
  @ApiOperation({ summary: 'My lucky game records' })
  luckyRecords(@CurrentUser() user: AuthenticatedUser, @Query() q: PaginationQueryDto) {
    return this.games.luckyRecords(this.actor(user), q);
  }

  @Get('jackpot-records')
  @NotGuest()
  @ApiOperation({ summary: 'My jackpot records' })
  jackpotRecords(@CurrentUser() user: AuthenticatedUser, @Query() q: PaginationQueryDto) {
    return this.games.jackpotRecords(this.actor(user), q);
  }

  @Get('tournaments')
  @ApiOperation({ summary: 'List tournaments' })
  tournaments(@Query() q: PaginationQueryDto) {
    return this.games.listTournaments(q);
  }

  @Get('tournaments/my-history')
  @NotGuest()
  @ApiOperation({ summary: 'My tournament history' })
  myTournaments(@CurrentUser() user: AuthenticatedUser, @Query() q: PaginationQueryDto) {
    return this.games.myTournaments(this.actor(user), q);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Global game wins leaderboard' })
  leaderboard(@Query() q: GameLeaderboardDto) {
    return this.games.leaderboard(q.limit);
  }
}
