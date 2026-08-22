import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ShiftActiveGuard } from 'src/modules/moderator-shift/guards/shift-active.guard';
import { SuspendedGuard } from 'src/modules/moderator-warning/guards/suspended.guard';
import {
  AssignReportDto,
  BlockVideoRoomUserDto,
  ForceDisconnectDto,
  KickVideoRoomUsersDto,
  ListModerationDto,
  MuteAllDto,
  MuteVideoRoomUserDto,
  ReportVideoRoomUserDto,
  ReviewReportDto,
  UnmuteAllDto,
  UnmuteVideoRoomUserDto,
  WarnVideoRoomUserDto,
} from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomModerationQueryService } from '../services/video-room-moderation-query.service';
import { VideoRoomModerationService } from '../services/video-room-moderation.service';
import { VideoRoomReportService } from '../services/video-room-report.service';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { BanUserGloballyDto } from 'src/modules/platform-moderation/dto/ban-user-globally.dto';
import { BroadBanService } from 'src/modules/platform-moderation/services/broad-ban.service';
import { BanBroadDto } from 'src/modules/platform-moderation/dto/ban-broad.dto';

/**
 * VR-16 moderation REST surface (base `video-rooms/:id/...`), mirroring every
 * other shipped video-room controller: JWT-guarded globally, thin request
 * shaping only. **All authorization lives in the services**
 * (`VideoRoomPermissionService.assertPermission` + owner-protection +
 * outranks) — this controller adds no permission guards of its own beyond
 * the global JWT guard.
 *
 * `@NotGuest()` appears on exactly one route, `/report`: every other command
 * here already requires an elevated permission the service enforces (a guest
 * holds none of them, so a guest attempt 403s there regardless), while
 * `/report` is deliberately open to any active member — including
 * audience/viewer — and only a guest needs to be turned away at the door.
 *
 * Every mutating command threads `@RequestMeta()` (`{requestId, ip,
 * userAgent}`) into the service call so it lands in the immutable
 * `VideoRoomModerationAction.metadata` audit blob (spec §8) — the one piece
 * of request provenance a controller is best placed to capture.
 */
@ApiTags('video-room-moderation')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsModerationController {
  constructor(
    private readonly moderation: VideoRoomModerationService,
    private readonly reports: VideoRoomReportService,
    private readonly query: VideoRoomModerationQueryService,
    private readonly platformBans: PlatformBanService,
    private readonly broadBans: BroadBanService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ======================= Global 24h Platform Ban =======================

  @Post(':id/moderation/platform-ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a user globally from all rooms for 24 hours' })
  async banGlobally(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserGloballyDto,
  ) {
    const actor = this.actor(user);
    await this.moderation.assertCanModerate(actor, roomId);
    const result = await this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'VIDEO_ROOM',
      originRoomId: roomId,
    });
    // Best-effort: eject them from the room being investigated right now if
    // they're an active participant there (not its owner — a room they own
    // is already force-ended by `banUser` above). Failures are expected and
    // swallowed — see the audio-room controller's identical courtesy step.
    void this.moderation.forceDisconnect(actor, roomId, userId, dto.reason).catch(() => {});
    return result;
  }

  @Post(':id/moderation/broad-ban')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ban this Broad (video room): end it now, evict everyone, block the owner from creating a new one for 24 hours',
  })
  async broadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: BanBroadDto,
  ) {
    const actor = this.actor(user);
    await this.moderation.assertCanModerate(actor, roomId);
    return this.broadBans.banBroad({
      moderatorId: user.id,
      roomId,
      roomType: 'VIDEO_ROOM',
      reason: dto.reason,
      description: dto.description,
      proofUrl: dto.proofUrl,
    });
  }

  // ======================= Kick =======================

  @Post(':id/moderation/kick')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kick one or more members from the room',
    description:
      'Requires KICK_USERS. Deactivates membership and hard-disconnects every socket the ' +
      'target holds; they may rejoin unless also blacklisted. Accepts one or many userIds — ' +
      'each target runs the full prereq chain independently, so one bad id (e.g. a target who ' +
      'outranks the actor) is reported as skipped rather than aborting the whole batch.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 200,
    description: 'Per-target outcome: { kicked: string[], skipped: {userId, reason}[] }',
  })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks KICK_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  kick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: KickVideoRoomUsersDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.kickMany(this.actor(user), roomId, dto.userIds, dto.reason, meta);
  }

  // ======================= Blacklist =======================

  @Post(':id/moderation/blacklist')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Durably blacklist a user from the room',
    description:
      'Requires BLOCK_USERS. Also ejects the target now if they are currently a member ' +
      '(blacklisting always implies an immediate kick).',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Blacklisted.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks BLOCK_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_ALREADY_BLOCKED' })
  blacklist(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: BlockVideoRoomUserDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.blacklist(
      this.actor(user),
      roomId,
      dto.userId,
      dto.reason,
      dto.type,
      dto.durationMinutes,
      meta,
    );
  }

  @Delete(':id/moderation/blacklist/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a blacklist entry',
    description: 'Requires BLOCK_USERS. Restorative — no self/owner-protection/outranks check.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiParam({ name: 'userId', description: 'The blacklisted user (uuid)' })
  @ApiResponse({ status: 200, description: 'Blacklist lifted.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks BLOCK_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND · VIDEO_ROOM_BLOCK_NOT_FOUND' })
  unblacklist(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.unblacklist(this.actor(user), roomId, userId, meta);
  }

  // ======================= Mute / unmute / mute-all =======================

  @Post(':id/moderation/mute')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mute a member on one or both channels (chat/mic)',
    description:
      'Requires MUTE_USERS. Omitting `channels` mutes both chat and mic. `chat` is a durable, ' +
      'dup-guarded mute row; `mic` delegates to the media force-mute pipeline.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Muted.' })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR — TEMPORARY requires durationMinutes',
  })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks MUTE_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_ALREADY_MUTED' })
  mute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: MuteVideoRoomUserDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.mute(this.actor(user), roomId, dto, meta);
  }

  @Post(':id/moderation/unmute')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a mute on one or both channels',
    description:
      'Requires MUTE_USERS. Omitting `channels` unmutes both. Restorative — no self/' +
      'owner-protection/outranks check.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Unmuted.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks MUTE_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND · VIDEO_ROOM_MUTE_NOT_FOUND' })
  unmute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: UnmuteVideoRoomUserDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.unmute(this.actor(user), roomId, dto.userId, dto.channels, meta);
  }

  @Post(':id/moderation/mute-all')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mute the whole room (all non-elevated members) on one or both channels',
    description:
      'Requires ROOM_MUTE. `chat` flips the room to READ_ONLY; `mic` sweeps every currently ' +
      'staged non-elevated participant through the media force-mute pipeline.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Room muted.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks ROOM_MUTE' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  muteAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: MuteAllDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.muteAll(this.actor(user), roomId, dto.channels, meta);
  }

  @Post(':id/moderation/unmute-all')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lift a whole-room mute on one or both channels',
    description:
      'Requires ROOM_MUTE. `chat` flips the room chat mode back to NORMAL; `mic` un-force-mutes ' +
      'every currently staged non-elevated participant `mute-all` would have swept. Reverse of ' +
      'mute-all — restorative, like unmute.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Room unmuted.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks ROOM_MUTE' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  unmuteAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: UnmuteAllDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.unmuteAll(this.actor(user), roomId, dto.channels, meta);
  }

  // ======================= Warn / force-disconnect =======================

  @Post(':id/moderation/warn')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a warning to a member',
    description:
      'Requires MUTE_USERS. No state change — a queryable record, the immutable audit trail, ' +
      'and a target-only notice. No auto-escalation ladder in this phase.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Warned.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks MUTE_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  warn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: WarnVideoRoomUserDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.warn(
      this.actor(user),
      roomId,
      dto.userId,
      dto.reason,
      dto.metadata,
      dto.scope ?? 'PRIVATE',
      meta,
    );
  }

  @Post(':id/moderation/warn/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue a warning to a member by param userId' })
  warnByParam(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: { reason: string; scope?: 'PRIVATE' | 'ROOM'; metadata?: Record<string, unknown> },
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.warn(
      this.actor(user),
      roomId,
      userId,
      dto.reason,
      dto.metadata,
      dto.scope ?? 'PRIVATE',
      meta,
    );
  }

  @Post(':id/moderation/escalate')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Escalate critical violation in video room to managers/admins' })
  escalate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body()
    dto: { targetUserId: string; reason: string; severity: 'HIGH' | 'CRITICAL' | 'EMERGENCY' },
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.escalateViolation(
      this.actor(user),
      roomId,
      dto.targetUserId,
      dto.reason,
      dto.severity,
      meta,
    );
  }

  @Post(':id/moderation/force-disconnect')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Forcibly disconnect a member's realtime session",
    description:
      'Requires KICK_USERS. Transient eject: ends every realtime session and hard-disconnects ' +
      'sockets, but — unlike kick — no membership deactivation and no durable mute/block row. ' +
      'The target stays a member and may simply reconnect.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Disconnected.' })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks KICK_USERS' })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  forceDisconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: ForceDisconnectDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.forceDisconnect(this.actor(user), roomId, dto.userId, dto.reason, meta);
  }

  // ======================= Report =======================

  @Post(':id/report')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Report another user in the room',
    description:
      'Open to any active member — including audience/viewer — hence the sole `@NotGuest` on ' +
      'this controller. Optionally scoped to a specific chat message. Notifies every elevated ' +
      'member and the room owner (never the reporter).',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 201, description: 'Report filed.' })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_ROOM_CANNOT_MODERATE_SELF — cannot report yourself',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_DUPLICATE_REPORT — a pending report already exists',
  })
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: ReportVideoRoomUserDto,
  ) {
    return this.reports.report(this.actor(user), roomId, dto);
  }

  @Post(':id/reports/:reportId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Moderator triage of a pending report',
    description: 'Requires MANAGE_PARTICIPANTS. Records the resolution and appends the audit row.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiParam({ name: 'reportId', description: 'The report id (uuid)' })
  @ApiResponse({ status: 200, description: 'Reviewed.' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — actor lacks MANAGE_PARTICIPANTS',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND · VIDEO_ROOM_REPORT_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_REPORT_NOT_PENDING — already reviewed' })
  reviewReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ReviewReportDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.reports.reviewReport(this.actor(user), roomId, reportId, dto, meta);
  }

  @Post(':id/reports/:reportId/assign')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a pending report to a moderator for investigation' })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiParam({ name: 'reportId', description: 'The report id (uuid)' })
  async assignReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: AssignReportDto,
  ) {
    await this.reports.assignReport(this.actor(user), roomId, reportId, dto.assigneeId);
    return { assigned: true };
  }

  @Post(':id/reports/:reportId/dismiss')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a false report (moderator)' })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiParam({ name: 'reportId', description: 'The report id (uuid)' })
  dismissReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: { reason?: string },
  ) {
    return this.reports.dismissReport(this.actor(user), roomId, reportId, dto.reason);
  }

  @Post(':id/reports/:reportId/notes')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add investigation notes to a report (moderator)' })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiParam({ name: 'reportId', description: 'The report id (uuid)' })
  addReportNotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: { notes: string },
  ) {
    return this.reports.addReportNotes(this.actor(user), roomId, reportId, dto.notes);
  }

  // ======================= Reads (elevated) =======================

  @Get(':id/moderation/history')
  @ApiOperation({
    summary: "The room's moderation audit trail",
    description:
      'Elevated read: any of KICK_USERS, BLOCK_USERS, MUTE_USERS. Newest first, optionally ' +
      'scoped to `targetUserId`.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — no elevated moderation permission',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() query: ListModerationDto,
  ) {
    return this.query.history(this.actor(user), roomId, query);
  }

  @Get(':id/reports')
  @ApiOperation({
    summary: 'Paginated reports filed in the room',
    description: 'Requires MANAGE_PARTICIPANTS. Optionally scoped to `targetUserId`.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — actor lacks MANAGE_PARTICIPANTS',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  listReports(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() query: ListModerationDto,
  ) {
    return this.reports.listReports(this.actor(user), roomId, query);
  }

  @Get(':id/muted-users')
  @ApiOperation({
    summary: "The room's current mute roster",
    description: 'Elevated read. Newest first, optionally scoped to `userId`.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — no elevated moderation permission',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  mutedUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() query: ListModerationDto,
  ) {
    return this.query.mutedUsers(this.actor(user), roomId, query);
  }

  @Get(':id/blacklisted-users')
  @ApiOperation({
    summary: "The room's blacklist (active blocks)",
    description: 'Elevated read. Newest first, optionally scoped to `userId`.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — no elevated moderation permission',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  blacklistedUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() query: ListModerationDto,
  ) {
    return this.query.blacklistedUsers(this.actor(user), roomId, query);
  }

  @Get(':id/moderation/warnings')
  @ApiOperation({
    summary: 'Warnings issued in the room',
    description: 'Elevated read. Newest first, optionally scoped to `userId`.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_FORBIDDEN — no elevated moderation permission',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND' })
  warnings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() query: ListModerationDto,
  ) {
    return this.query.warnings(this.actor(user), roomId, query);
  }
}
