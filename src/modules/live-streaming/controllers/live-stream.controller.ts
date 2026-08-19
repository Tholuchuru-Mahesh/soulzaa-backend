import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LiveStreamReportReason, LiveStreamReportStatus, LiveStreamStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ShiftActiveGuard } from 'src/modules/moderator-shift/guards/shift-active.guard';
import { SuspendedGuard } from 'src/modules/moderator-warning/guards/suspended.guard';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { BanUserGloballyDto } from 'src/modules/platform-moderation/dto/ban-user-globally.dto';
import { LiveStreamReportService } from '../services/live-stream-report.service';
import { LiveStreamService } from '../services/live-stream.service';

class CreateStreamDto {
  title?: string;
  description?: string;
}

class ModerateStreamUserDto {
  targetUserId!: string;
  action!: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
  /** Minutes until a MUTE/BAN self-lifts. Omit for PERMANENT. */
  durationMinutes?: number;
  /** Only meaningful for WARN: PRIVATE (default) or ROOM-wide system broadcast. */
  scope?: 'PRIVATE' | 'ROOM';
}

class FileReportDto {
  targetUserId!: string;
  reason!: LiveStreamReportReason;
  description?: string;
}

class ReviewReportDto {
  status!: LiveStreamReportStatus;
  resolution?: string;
  recommendedAction?: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
}

@ApiTags('live-streaming')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('live-streams')
export class LiveStreamController {
  constructor(
    private readonly service: LiveStreamService,
    private readonly reports: LiveStreamReportService,
    private readonly platformBans: PlatformBanService,
  ) {}

  @Post(':id/moderation/platform-ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Ban a user globally from all rooms for 24 hours' })
  banGlobally(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) streamId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserGloballyDto,
  ) {
    return this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'LIVE_STREAM',
      originRoomId: streamId,
    });
  }

  @Post()
  @RequirePermissions('live.stream.create')
  @ApiOperation({ summary: 'Host creates a new live stream' })
  createStream(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStreamDto) {
    return this.service.createStream({
      hostId: user.id,
      hostRoles: user.roles,
      title: dto.title,
      description: dto.description,
    });
  }

  @Get()
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'List active live streams' })
  listStreams(
    @Query('status') status?: LiveStreamStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listStreams(
      { status: status ?? LiveStreamStatus.ACTIVE },
      Number(page ?? 1),
      Number(limit ?? 20),
    );
  }

  @Get(':id')
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'Get live stream details' })
  getStream(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getStream(id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.manage')
  @ApiOperation({ summary: 'End a live stream (Host or Admin)' })
  endStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.endStream(id, user.id);
  }

  @Post(':id/moderation')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Perform moderation action in live stream (Warn, Mute, Kick, Ban)' })
  moderateUser(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ModerateStreamUserDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.service.moderateUser(
      {
        streamId: id,
        moderatorId: user.id,
        targetUserId: dto.targetUserId,
        action: dto.action,
        reason: dto.reason,
        durationMinutes: dto.durationMinutes,
        scope: dto.scope,
      },
      meta,
    );
  }

  @Get(':id/moderation/actions')
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({
    summary: 'Get moderation action trail for a live stream (optionally filter by target user)',
  })
  getActions(@Param('id', ParseUuidPipe) id: string, @Query('targetUserId') targetUserId?: string) {
    return this.service.getStreamActions(id, targetUserId);
  }

  @Post(':id/moderation/escalate')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Escalate critical violation in live stream to managers/admins' })
  escalate(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    dto: { targetUserId: string; reason: string; severity: 'HIGH' | 'CRITICAL' | 'EMERGENCY' },
  ) {
    return this.service.escalateViolation(id, user.id, dto.targetUserId, dto.reason, dto.severity);
  }

  // ======================= Reports =======================

  @Post(':id/reports')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'Report a user in the live stream' })
  fileReport(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FileReportDto,
  ) {
    return this.reports.fileReport({
      streamId: id,
      reporterId: user.id,
      targetUserId: dto.targetUserId,
      reason: dto.reason,
      description: dto.description,
    });
  }

  @Post(':id/reports/:reportId/review')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Review/resolve a report, optionally executing a recommended action' })
  async reviewReport(
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewReportDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    await this.reports.reviewReport(
      {
        streamId: id,
        reportId,
        moderatorId: user.id,
        status: dto.status,
        resolution: dto.resolution,
        recommendedAction: dto.recommendedAction,
      },
      meta,
    );
    return { reviewed: true };
  }

  @Post(':id/reports/:reportId/notes')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Add investigation notes to a report' })
  async addReportNotes(
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: { notes: string },
  ) {
    await this.reports.addNotes(id, reportId, user.id, dto.notes);
    return { added: true };
  }

  @Get(':id/reports')
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'List reports for a live stream (optionally filter by target user)' })
  listReports(
    @Param('id', ParseUuidPipe) id: string,
    @Query('targetUserId') targetUserId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reports.listReports(id, Number(page ?? 1), Number(limit ?? 20), targetUserId);
  }

  // ======================= Realtime Presence (Redis-only, Anonymous Moderator) =======================

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.view')
  @ApiOperation({
    summary: 'Join live stream viewer presence (ephemeral, anonymous for moderators)',
  })
  joinStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.joinStream(id, user);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'Leave live stream viewer presence' })
  leaveStream(@Param('id', ParseUuidPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.leaveStream(id, user);
  }

  @Get(':id/viewers')
  @RequirePermissions('live.stream.view')
  @ApiOperation({ summary: 'List public stream viewers (excludes moderators)' })
  getViewers(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getStreamViewers(id);
  }
}
