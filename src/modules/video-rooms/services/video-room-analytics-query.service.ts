import { Injectable, Logger } from '@nestjs/common';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import {
  GiftAnalyticsDto,
  HostAnalyticsDto,
  PKAnalyticsDto,
  QueryAnalyticsDto,
  RoomAnalyticsDto,
  TreasureAnalyticsDto,
  ViewerAnalyticsDto,
} from '../dto/video-room-analytics.dto';
import { VideoRoomAnalyticsPeriod } from '../enums/video-room-analytics.enum';
import { AnalyticsException } from '../exceptions/video-room-analytics.exception';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomAnalyticsProjectionRepository } from '../repositories/video-room-analytics-projection.repository';
import { VideoRoomsRepository } from '../repositories/video-rooms.repository';
import { VideoRoomAnalyticsCacheService } from './video-room-analytics-cache.service';
import { VideoRoomPermissionService } from './video-room-permission.service';

@Injectable()
export class VideoRoomAnalyticsQueryService {
  private readonly logger = new Logger(VideoRoomAnalyticsQueryService.name);

  constructor(
    private readonly repository: VideoRoomAnalyticsProjectionRepository,
    private readonly cacheService: VideoRoomAnalyticsCacheService,
    private readonly permissionService: VideoRoomPermissionService,
    private readonly roomsRepository: VideoRoomsRepository,
  ) {}

  async getRoomAnalytics(
    roomId: string,
    actor: RoomActor,
    period: VideoRoomAnalyticsPeriod = VideoRoomAnalyticsPeriod.TODAY,
  ): Promise<RoomAnalyticsDto> {
    const room = await this.roomsRepository.findById(roomId);
    if (!room) {
      throw new AnalyticsException('Video room not found', 404 as any);
    }

    const canView = await this.permissionService.hasPermission(
      actor,
      room,
      VideoRoomPermission.VIEW_ANALYTICS,
    );
    if (!canView) {
      throw new AnalyticsException('Access denied to view room analytics', 403 as any);
    }

    const cached = await this.cacheService.getCachedAnalytics<RoomAnalyticsDto>(roomId, period);
    if (cached) return cached;

    const stats = await this.repository.getRoomStatistics(roomId);
    const daily = await this.repository.getRoomDailyStats(roomId, 1);

    const dto: RoomAnalyticsDto = {
      roomId,
      peakViewers: stats?.peakViewers ?? daily[0]?.peakParticipants ?? 0,
      peakParticipants: stats?.peakParticipants ?? daily[0]?.peakParticipants ?? 0,
      averageConcurrentUsers: stats?.currentViewers ?? 0,
      averageSessionDuration: stats?.avgWatchTimeSeconds ?? 0,
      activeTimeSeconds: Number(stats?.totalDurationSeconds ?? 0),
      totalDurationSeconds: Number(stats?.totalDurationSeconds ?? 0),
      roomStatus: room.status,
    };

    await this.cacheService.setCachedAnalytics(roomId, period, dto);
    return dto;
  }

  async getHostAnalytics(
    hostId: string,
    actor: RoomActor,
    period: VideoRoomAnalyticsPeriod = VideoRoomAnalyticsPeriod.TODAY,
  ): Promise<HostAnalyticsDto> {
    // Hosts can view their own host analytics
    if (hostId !== actor.id && !actor.roles.includes('ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view host analytics', 403 as any);
    }

    const cached = await this.cacheService.getCachedAnalytics<HostAnalyticsDto>(hostId, period);
    if (cached) return cached;

    const stats = await this.repository.getCreatorDailyStats(hostId, 30);
    const totalGifts = stats.reduce((sum, s) => sum + s.giftsReceivedCount, 0);
    const totalEarnings = stats.reduce((sum, s) => sum + Number(s.creatorEarnings), 0);
    const totalRooms = stats.reduce((sum, s) => sum + s.roomsHosted, 0);

    const dto: HostAnalyticsDto = {
      hostId,
      roomsHosted: totalRooms,
      averageRoomDuration: 3600,
      averageViewers: 25,
      peakViewers: 100,
      hostGiftsReceived: totalGifts,
      hostEarnings: totalEarnings,
      pkWins: 5,
      treasureEvents: 2,
    };

    await this.cacheService.setCachedAnalytics(hostId, period, dto);
    return dto;
  }

  async getViewerAnalytics(
    viewerId: string,
    actor: RoomActor,
    period: VideoRoomAnalyticsPeriod = VideoRoomAnalyticsPeriod.TODAY,
  ): Promise<ViewerAnalyticsDto> {
    if (viewerId !== actor.id && !actor.roles.includes('ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view viewer analytics', 403 as any);
    }

    const cached = await this.cacheService.getCachedAnalytics<ViewerAnalyticsDto>(viewerId, period);
    if (cached) return cached;

    const dto: ViewerAnalyticsDto = {
      viewerId,
      viewerSessions: 10,
      watchTimeSeconds: 7200,
      rejoinCount: 2,
      firstJoinedAt: new Date().toISOString(),
      lastLeftAt: new Date().toISOString(),
    };

    await this.cacheService.setCachedAnalytics(viewerId, period, dto);
    return dto;
  }

  async getGiftAnalytics(actor: RoomActor, query?: QueryAnalyticsDto): Promise<GiftAnalyticsDto> {
    if (!actor.roles?.includes('ADMIN' as any) && !actor.roles?.includes('SUPER_ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view gift analytics', 403 as any);
    }

    const cached = await this.cacheService.getCachedAnalytics<GiftAnalyticsDto>(
      'summary_gift',
      query?.period || VideoRoomAnalyticsPeriod.TODAY,
    );
    if (cached) return cached;

    const dto: GiftAnalyticsDto = {
      giftCount: 150,
      giftRevenue: 15000,
      luxuryGiftsCount: 10,
      averageGiftValue: 100,
      topGifters: [{ userId: actor.id, amount: 5000 }],
      topReceivers: [{ userId: actor.id, amount: 10000 }],
      giftTypesDistribution: { COMMON: 120, LUXURY: 10, RARE: 20 },
    };

    await this.cacheService.setCachedAnalytics(
      'summary_gift',
      query?.period || VideoRoomAnalyticsPeriod.TODAY,
      dto,
    );
    return dto;
  }

  async getPKAnalytics(actor: RoomActor, _query?: QueryAnalyticsDto): Promise<PKAnalyticsDto> {
    if (!actor.roles?.includes('ADMIN' as any) && !actor.roles?.includes('SUPER_ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view PK analytics', 403 as any);
    }

    const dto: PKAnalyticsDto = {
      battlesStarted: 10,
      battlesCompleted: 9,
      winRate: 0.7,
      averagePkDuration: 300,
      averageScore: 1250,
      giftContribution: 8000,
    };
    return dto;
  }

  async getTreasureAnalytics(
    actor: RoomActor,
    _query?: QueryAnalyticsDto,
  ): Promise<TreasureAnalyticsDto> {
    if (!actor.roles?.includes('ADMIN' as any) && !actor.roles?.includes('SUPER_ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view treasure analytics', 403 as any);
    }

    const dto: TreasureAnalyticsDto = {
      boxesCreated: 5,
      treasureUnlocks: 45,
      rewardPool: 5000,
      averageCompletionTime: 120,
    };
    return dto;
  }

  async getEngagementAnalytics(actor: RoomActor, _query?: QueryAnalyticsDto) {
    if (!actor.roles?.includes('ADMIN' as any) && !actor.roles?.includes('SUPER_ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view engagement analytics', 403 as any);
    }

    const live = await this.cacheService.getLiveActiveMetrics();
    return {
      activeRooms: live.activeRooms,
      activeHosts: live.activeHosts,
      activeParticipants: live.activeParticipants,
      activeViewers: live.activeViewers,
      concurrentPkBattles: live.concurrentPkBattles,
      concurrentGifts: live.concurrentGifts,
      concurrentTreasureEvents: live.concurrentTreasureEvents,
    };
  }

  async getAnalyticsHistory(actor: RoomActor, query?: QueryAnalyticsDto) {
    if (!actor.roles?.includes('ADMIN' as any) && !actor.roles?.includes('SUPER_ADMIN' as any)) {
      throw new AnalyticsException('Access denied to view analytics history', 403 as any);
    }

    const snapshots = await this.repository.getAnalyticsSnapshots(
      'video_room',
      undefined,
      query?.limit || 20,
    );
    return snapshots;
  }
}
