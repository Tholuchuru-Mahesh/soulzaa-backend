import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  GiftAnalyticsDto,
  HostAnalyticsDto,
  PKAnalyticsDto,
  QueryAnalyticsDto,
  RoomAnalyticsDto,
  TreasureAnalyticsDto,
  ViewerAnalyticsDto,
} from '../dto/video-room-analytics.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomAnalyticsQueryService } from '../services/video-room-analytics-query.service';

/**
 * VR-17 Video Room Analytics & Insights Engine REST Controller.
 * Exposes endpoints for room, host, viewer, gift, PK, treasure, engagement, and historical analytics.
 */
@ApiTags('video-room-analytics')
@ApiBearerAuth()
@Controller(['video-room/analytics', 'video-rooms/analytics'])
export class VideoRoomsAnalyticsController {
  constructor(private readonly queryService: VideoRoomAnalyticsQueryService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: (user.roles || []) as any };
  }

  @Get('room/:roomId')
  @ApiOperation({
    summary: 'Get room analytics',
    description:
      'Retrieves room performance, duration, peak participants/viewers, and engagement metrics.',
  })
  @ApiParam({ name: 'roomId', description: 'Video room UUID' })
  @ApiResponse({ status: 200, type: RoomAnalyticsDto })
  @ApiResponse({ status: 403, description: 'Access denied (View Analytics permission required)' })
  @ApiResponse({ status: 404, description: 'Video room not found' })
  getRoomAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.queryService.getRoomAnalytics(roomId, this.actor(user), query.period);
  }

  @Get('host/:hostId')
  @ApiOperation({
    summary: 'Get host analytics',
    description:
      'Retrieves host summary including rooms hosted, earnings, peak viewers, and PK/treasure stats.',
  })
  @ApiParam({ name: 'hostId', description: 'Host User UUID' })
  @ApiResponse({ status: 200, type: HostAnalyticsDto })
  @ApiResponse({ status: 403, description: 'Access denied' })
  getHostAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('hostId', ParseUuidPipe) hostId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.queryService.getHostAnalytics(hostId, this.actor(user), query.period);
  }

  @Get('viewer/:viewerId')
  @ApiOperation({
    summary: 'Get viewer analytics',
    description: 'Retrieves viewer session history, watch time, and rejoin metrics.',
  })
  @ApiParam({ name: 'viewerId', description: 'Viewer User UUID' })
  @ApiResponse({ status: 200, type: ViewerAnalyticsDto })
  @ApiResponse({ status: 403, description: 'Access denied' })
  getViewerAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('viewerId', ParseUuidPipe) viewerId: string,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.queryService.getViewerAnalytics(viewerId, this.actor(user), query.period);
  }

  @Get('gifts')
  @ApiOperation({
    summary: 'Get gift analytics',
    description:
      'Retrieves video room gift revenue, top gifters/receivers, and luxury gift distribution.',
  })
  @ApiResponse({ status: 200, type: GiftAnalyticsDto })
  getGiftAnalytics(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryAnalyticsDto) {
    return this.queryService.getGiftAnalytics(this.actor(user), query);
  }

  @Get('pk')
  @ApiOperation({
    summary: 'Get PK battle analytics',
    description:
      'Retrieves PK battle statistics, win rate, average duration, and score distribution.',
  })
  @ApiResponse({ status: 200, type: PKAnalyticsDto })
  getPKAnalytics(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryAnalyticsDto) {
    return this.queryService.getPKAnalytics(this.actor(user), query);
  }

  @Get('treasure')
  @ApiOperation({
    summary: 'Get treasure box analytics',
    description:
      'Retrieves treasure box creation, unlock rates, reward pool distribution, and average completion time.',
  })
  @ApiResponse({ status: 200, type: TreasureAnalyticsDto })
  getTreasureAnalytics(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryAnalyticsDto) {
    return this.queryService.getTreasureAnalytics(this.actor(user), query);
  }

  @Get('engagement')
  @ApiOperation({
    summary: 'Get real-time engagement analytics',
    description:
      'Retrieves active rooms, active hosts/participants/viewers, and concurrent PK/gift/treasure events.',
  })
  @ApiResponse({ status: 200, description: 'Real-time active metrics payload' })
  getEngagementAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.queryService.getEngagementAnalytics(this.actor(user), query);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get historical analytics snapshots',
    description: 'Retrieves historical time-series analytics snapshots for trend analysis.',
  })
  @ApiResponse({ status: 200, description: 'Historical analytics snapshot list' })
  getAnalyticsHistory(@CurrentUser() user: AuthenticatedUser, @Query() query: QueryAnalyticsDto) {
    return this.queryService.getAnalyticsHistory(this.actor(user), query);
  }
}
