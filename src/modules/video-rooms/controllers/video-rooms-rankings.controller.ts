import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  VideoRoomRankingDimension,
  scopeCity,
  scopeCountry,
  scopeGlobal,
  scopeRoom,
} from '../constants/video-room-ranking.constants';
import {
  LeaderboardResponseDto,
  QueryRankingDto,
  RankingAudienceDto,
  RankingHistoryResponseDto,
  SelfRankResponseDto,
} from '../dto/video-room-ranking.dto';
import { VideoRoomLeaderboardService } from '../services/video-room-leaderboard.service';
import type { RankingQuery, RankingViewer } from '../services/video-room-ranking-query.service';
import { VideoRoomRankingQueryService } from '../services/video-room-ranking-query.service';

/**
 * VR-13 ranking REST surface (base `video-rooms/rankings`).
 *
 * Every route is a read. Rankings are never mutated over HTTP — they move only
 * in response to domain events and aggregation jobs, which is what keeps the
 * ladder a derived projection rather than something a client can push.
 *
 * The path prefix is `video-rooms` (plural), matching every shipped video-room
 * controller. The phase brief writes `/video-room/rankings/...` singular;
 * consistency with the deployed surface wins.
 *
 * Authorization — including the guest limit — lives in
 * `VideoRoomRankingQueryService`, never inline here. This is the VR-10/11/12
 * controller convention.
 */
@ApiTags('video-room-rankings')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsRankingsController {
  constructor(
    private readonly query: VideoRoomRankingQueryService,
    private readonly boards: VideoRoomLeaderboardService,
  ) {}

  /** `isGuest` is optional on the token claim; absent means a full account. */
  private viewer(user: AuthenticatedUser): RankingViewer {
    return { id: user.id, isGuest: user.isGuest === true };
  }

  private toQuery(
    dto: QueryRankingDto,
    dimension: VideoRoomRankingDimension,
    scope: string,
  ): RankingQuery {
    return {
      dimension,
      period: dto.period,
      dateKey: dto.dateKey,
      scope,
      limit: dto.limit,
      page: dto.page,
    };
  }

  /** Ladder read, or a friends/following projection when one is requested. */
  private read(
    user: AuthenticatedUser,
    dto: QueryRankingDto,
    dimension: VideoRoomRankingDimension,
    scope: string = scopeGlobal(),
  ) {
    const viewer = this.viewer(user);
    const query = this.toQuery(dto, dimension, scope);
    if (dto.audience === RankingAudienceDto.FRIENDS) {
      return this.boards.projectAudience(viewer, query, 'friends');
    }
    if (dto.audience === RankingAudienceDto.FOLLOWING) {
      return this.boards.projectAudience(viewer, query, 'following');
    }
    return this.query.getLadder(viewer, query);
  }

  private geoScope(dto: QueryRankingDto): string {
    // City is the narrower of the two; when both arrive it is what was meant.
    if (dto.city) return scopeCity(dto.city);
    if (dto.country) return scopeCountry(dto.country);
    return scopeGlobal();
  }

  @Get('rankings/global')
  @ApiOperation({
    summary: 'Global leaderboard for any dimension',
    description:
      'The global-scope entry point. `dimension` selects the ladder (default `hosts`); ' +
      'this is not a separate ranking. Guests receive the top 10 only, without ' +
      'pagination or historical windows.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_ROOM_RANKING_PERIOD_INVALID — dateKey does not parse for the period; or ' +
      'VIDEO_ROOM_RANKING_INVALID — unknown dimension',
  })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_RANKING_INVALID — a guest requested page > 1, a historical dateKey, or a projection',
  })
  global(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, dto.dimension);
  }

  @Get('rankings/hosts')
  @ApiOperation({
    summary: 'Top hosts',
    description:
      'Composite of coins received, gift count, watch time, peak viewers, PK wins and ' +
      'treasure events while holding a seat. Weights are config-driven.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({ status: 403, description: 'guest limit exceeded' })
  hosts(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.HOSTS);
  }

  @Get('rankings/gifters')
  @ApiOperation({
    summary: 'Top gifters',
    description:
      'Coins spent in video rooms. Distinct from GET /rankings/gifters, which is the ' +
      'platform-wide ladder across every context.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  gifters(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.GIFTERS);
  }

  @Get('rankings/receivers')
  @ApiOperation({ summary: 'Top receivers', description: 'Coins received in video rooms.' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  receivers(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.RECEIVERS);
  }

  @Get('rankings/rooms')
  @ApiOperation({
    summary: 'Top rooms',
    description:
      'Engagement composite: gift revenue, peak viewers, average watch time, PK battles ' +
      'and treasure activity. Entries are rooms — `targetId` is a room id.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  rooms(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.ROOMS);
  }

  @Get('rankings/pk')
  @ApiOperation({
    summary: 'PK leaderboard',
    description: 'Wins weighted heavily over raw battle score. Draws count as neither.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  pk(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.PK);
  }

  @Get('rankings/treasure')
  @ApiOperation({ summary: 'Treasure winners', description: 'Coins won from treasure boxes.' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  treasure(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.TREASURE);
  }

  @Get('rankings/vip')
  @ApiOperation({
    summary: 'VIP leaderboard',
    description: 'Ordered by VIP level; coins spent breaks ties within a level only.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({ status: 400, description: 'VIDEO_ROOM_RANKING_PERIOD_INVALID' })
  @ApiResponse({
    status: 403,
    description:
      'guest limit exceeded — page > 1, a historical dateKey, or a friends/following projection',
  })
  vip(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, VideoRoomRankingDimension.VIP);
  }

  @Get('rankings/country')
  @ApiOperation({
    summary: 'Country or city leaderboard',
    description:
      'Ranks users WITHIN a geography — "top hosts in India this week". Pass `country` ' +
      '(ISO-3166 alpha-2) or `city`; `city` wins when both are given. Countries are ' +
      'not ranked against one another.',
  })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_ROOM_RANKING_PERIOD_INVALID — dateKey does not parse for the period; or ' +
      'VIDEO_ROOM_RANKING_INVALID — unknown dimension; or country must be an ISO-3166 ' +
      'alpha-2 code',
  })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_RANKING_INVALID — a guest requested page > 1, a historical dateKey, or a projection',
  })
  country(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.read(user, dto, dto.dimension, this.geoScope(dto));
  }

  @Get('rankings/me')
  @ApiOperation({
    summary: 'Your own position',
    description: 'Your 1-based rank and score. `rank` is null when you are unranked.',
  })
  @ApiResponse({ status: 200, type: SelfRankResponseDto })
  @ApiResponse({ status: 403, description: 'guests have no ranking position' })
  me(@CurrentUser() user: AuthenticatedUser, @Query() dto: QueryRankingDto) {
    return this.query.getSelfRank(this.viewer(user), dto.dimension, dto.period, this.geoScope(dto));
  }

  @Get('rankings/history')
  @ApiOperation({
    summary: 'Historical positions for one entity',
    description:
      'Snapshot-backed. Returns the most recent windows first for the given dimension ' +
      'and period. Not available to guests.',
  })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description:
      'Entity to read history for (user id, or room id on the `rooms` dimension). ' +
      'Defaults to the caller. Must be a uuid.',
  })
  @ApiResponse({ status: 200, type: [RankingHistoryResponseDto] })
  @ApiResponse({ status: 403, description: 'guests may not read ranking history' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: QueryRankingDto,
    @Query('targetId', new ParseUUIDPipe({ version: '4', optional: true }))
    targetId?: string,
  ) {
    return this.query.getHistory(
      this.viewer(user),
      targetId ?? user.id,
      dto.dimension,
      dto.period,
      dto.limit,
    );
  }

  @Get(':id/rankings')
  @ApiOperation({
    summary: 'Leaderboard scoped to one room',
    description:
      'The same dimensions, restricted to activity in this room — "top supporters in ' +
      'this room today". Room ladders carry a TTL, so a long-closed room returns empty.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: LeaderboardResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_ROOM_RANKING_PERIOD_INVALID — dateKey does not parse for the period; or ' +
      'VIDEO_ROOM_RANKING_INVALID — unknown dimension',
  })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_RANKING_INVALID — a guest requested page > 1, a historical dateKey, or a projection',
  })
  roomLadder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() dto: QueryRankingDto,
  ) {
    return this.read(user, dto, dto.dimension, scopeRoom(roomId));
  }
}
