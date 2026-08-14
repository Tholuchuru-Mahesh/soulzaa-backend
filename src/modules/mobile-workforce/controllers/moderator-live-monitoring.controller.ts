import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { WorkforceScopeService } from '../services/workforce-scope.service';
import { LiveStreamStatus } from '@prisma/client';

/**
 * Task 22 — Region-Scoped Live Monitoring endpoint.
 * Returns active audio rooms, video rooms, and live streams counts + lists
 * scoped by the moderator's assigned region.
 */
@ApiTags('Moderation - Live Monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderation/live-monitoring')
export class ModeratorLiveMonitoringController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
  ) {}

  @Get()
  @RequirePermissions('mobile.workforce.view')
  @ApiOperation({
    summary: 'Region-scoped live monitoring: active rooms and streams for the assigned region',
  })
  async getLiveMonitoring(@CurrentUser() user: AuthenticatedUser) {
    const scopeWhere = await this.scope.userScopeFilter(user.id);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    // For region-scoped moderators, find users in region to use as a room host/creator filter
    let userIdsInScope: string[] | undefined;
    if (!isUnrestricted) {
      const inScope = await this.prisma.user.findMany({
        where: scopeWhere,
        select: { id: true },
        take: 5000,
      });
      userIdsInScope = inScope.map((u) => u.id);
    }

    const scopedFilter = userIdsInScope ? { hostId: { in: userIdsInScope } } : {};

    const audioRoomScopeFilter = userIdsInScope ? { ownerId: { in: userIdsInScope } } : {};

    const [audioRooms, videoRooms, liveStreams] = await Promise.all([
      this.prisma.audioRoom.findMany({
        where: { status: 'LIVE' as any, ...audioRoomScopeFilter },
        select: { id: true, name: true, ownerId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.videoRoom.findMany({
        where: { status: 'ACTIVE' as any, ...audioRoomScopeFilter },
        select: { id: true, name: true, ownerId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.liveStream.findMany({
        where: { status: LiveStreamStatus.ACTIVE, ...scopedFilter },
        select: { id: true, title: true, hostId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);

    return {
      region: isUnrestricted ? 'ALL' : 'SCOPED',
      activeAudioRooms: {
        count: audioRooms.length,
        rooms: audioRooms,
      },
      activeVideoRooms: {
        count: videoRooms.length,
        rooms: videoRooms,
      },
      activeLiveStreams: {
        count: liveStreams.length,
        streams: liveStreams,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
