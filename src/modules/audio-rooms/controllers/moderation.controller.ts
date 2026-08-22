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
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestMeta } from 'src/common/decorators/request-meta.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import type { RequestMetadata } from 'src/common/interfaces/request-metadata.interface';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AddNoteDto,
  AppealDto,
  AssignReportDto,
  BanDto,
  KickDto,
  ListModerationDto,
  MuteDto,
  ReportDto,
  ResolveAppealDto,
  ReviewReportDto,
  WarnDto,
} from '../dto/moderation.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { ModerationService } from '../services/moderation.service';
import { RoomPermissionService } from '../services/room-permission.service';

import { ShiftActiveGuard } from 'src/modules/moderator-shift/guards/shift-active.guard';
import { SuspendedGuard } from 'src/modules/moderator-warning/guards/suspended.guard';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
import { BanUserGloballyDto } from 'src/modules/platform-moderation/dto/ban-user-globally.dto';
import { BroadBanService } from 'src/modules/platform-moderation/services/broad-ban.service';
import { BanBroadDto } from 'src/modules/platform-moderation/dto/ban-broad.dto';

/**
 * AR-3 moderation REST surface (base `rooms/:id/moderation/...`). JWT-guarded
 * globally; in-room permission + role-hierarchy checks live in the service (which
 * also honours platform MODERATOR/ADMIN/SUPER_ADMIN). Report + appeal submission
 * are member/user actions (`@NotGuest`); everything else requires moderator
 * authority, enforced in the service.
 */
@ApiTags('audio-room-moderation')
@ApiBearerAuth()
@Controller('rooms')
export class ModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly platformBans: PlatformBanService,
    private readonly broadBans: BroadBanService,
    private readonly permissions: RoomPermissionService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Actions on a target user ----

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
    await this.permissions.assertCanModerate(roomId, actor);
    const result = await this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'AUDIO_ROOM',
      originRoomId: roomId,
    });
    // Best-effort: if the target is currently an active participant in the
    // room being investigated (not its owner — a room they own is already
    // force-ended by `banUser` above), eject them right now instead of
    // leaving them connected until their next API call 403s. Failures
    // (not a member, or they *are* the owner) are expected and swallowed —
    // this is a courtesy on top of the ban, not a load-bearing step of it.
    void this.moderation.forceDisconnect(actor, roomId, userId, dto.reason).catch(() => {});
    return result;
  }

  @Post(':id/moderation/broad-ban')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ban this Broad (room): end it now, evict everyone, block the owner from creating a new one for 24 hours',
  })
  async broadBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: BanBroadDto,
  ) {
    const actor = this.actor(user);
    await this.permissions.assertCanModerate(roomId, actor);
    return this.broadBans.banBroad({
      moderatorId: user.id,
      roomId,
      roomType: 'AUDIO_ROOM',
      reason: dto.reason,
      description: dto.description,
      proofUrl: dto.proofUrl,
    });
  }

  @Post(':id/moderation/kick/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Kick a user from the room' })
  async kick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: KickDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    await this.moderation.kick(this.actor(user), id, userId, dto.reason, meta);
    return { kicked: true };
  }

  @Post(':id/moderation/unkick/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a kicked user (remove them from the kick list)' })
  async unkick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.moderation.unkick(this.actor(user), id, userId);
    return { unkicked: true };
  }

  @Post(':id/moderation/ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a user (temporary or permanent)' })
  ban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.ban(this.actor(user), id, userId, dto, meta);
  }

  @Post(':id/moderation/unban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a ban' })
  async unban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.moderation.unban(this.actor(user), id, userId);
    return { unbanned: true };
  }

  @Post(':id/moderation/mute/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute a member (temporary or permanent)' })
  mute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: MuteDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.moderation.mute(this.actor(user), id, userId, dto, meta);
  }

  @Post(':id/moderation/unmute/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a mute' })
  async unmute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.moderation.unmute(this.actor(user), id, userId);
    return { unmuted: true };
  }

  @Post(':id/moderation/warn/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Warn a user' })
  async warn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: WarnDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    await this.moderation.warn(
      this.actor(user),
      id,
      userId,
      dto.reason,
      dto.scope ?? 'PRIVATE',
      meta,
    );
    return { warned: true };
  }

  @Post(':id/moderation/escalate')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Escalate critical violation in audio room to managers/admins' })
  async escalate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body()
    dto: { targetUserId: string; reason: string; severity: 'HIGH' | 'CRITICAL' | 'EMERGENCY' },
    @RequestMeta() meta: RequestMetadata,
  ) {
    await this.moderation.escalateViolation(
      this.actor(user),
      id,
      dto.targetUserId,
      dto.reason,
      dto.severity,
      meta,
    );
    return { escalated: true };
  }

  // ---- Reports ----

  @Post(':id/moderation/report')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Report a user in the room' })
  report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ReportDto,
  ) {
    return this.moderation.report(this.actor(user), id, dto);
  }

  @Post(':id/moderation/reports/:reportId/review')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Review/resolve a report (moderator)' })
  async reviewReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ReviewReportDto,
  ) {
    await this.moderation.reviewReport(this.actor(user), id, reportId, dto);
    return { reviewed: true };
  }

  @Post(':id/moderation/reports/:reportId/assign')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a pending report to a moderator for investigation' })
  async assignReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: AssignReportDto,
  ) {
    await this.moderation.assignReport(this.actor(user), id, reportId, dto.assigneeId);
    return { assigned: true };
  }

  @Post(':id/moderation/reports/:reportId/dismiss')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a false report (moderator)' })
  async dismissReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: { reason?: string },
  ) {
    await this.moderation.dismissReport(this.actor(user), id, reportId, dto.reason);
    return { dismissed: true };
  }

  @Post(':id/moderation/reports/:reportId/notes')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add investigation notes to a report (moderator)' })
  async addReportNotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: { notes: string },
  ) {
    await this.moderation.addReportNotes(this.actor(user), id, reportId, dto.notes);
    return { noted: true };
  }

  // ---- Notes ----

  @Post(':id/moderation/notes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a moderator note about a user' })
  async addNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AddNoteDto,
  ) {
    await this.moderation.addNote(this.actor(user), id, dto.targetUserId, dto.note);
    return { noted: true };
  }

  // ---- Appeals ----

  @Post(':id/moderation/appeals')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Appeal a ban or mute' })
  submitAppeal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AppealDto,
  ) {
    return this.moderation.submitAppeal(this.actor(user), id, dto);
  }

  @Post(':id/moderation/appeals/:appealId/resolve')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve an appeal (moderator)' })
  async resolveAppeal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('appealId', ParseUuidPipe) appealId: string,
    @Body() dto: ResolveAppealDto,
  ) {
    await this.moderation.resolveAppeal(this.actor(user), id, appealId, dto);
    return { resolved: true };
  }

  // ---- Reads (moderation logs / kick list / ban list) ----

  @Get(':id/moderation/kicks')
  @ApiOperation({ summary: 'The room kick list — currently-kicked users (moderator only)' })
  kicks(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: ListModerationDto,
  ) {
    return this.moderation.listKicks(this.actor(user), id, q);
  }

  @Get(':id/moderation/bans')
  @ApiOperation({ summary: 'List active bans' })
  bans(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listBans(id, q);
  }

  @Get(':id/moderation/mutes')
  @ApiOperation({ summary: 'List active mutes' })
  mutes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listMutes(id, q);
  }

  @Get(':id/moderation/actions')
  @ApiOperation({ summary: 'Moderation action log (kick history / audit)' })
  actions(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listActions(id, q);
  }

  @Get(':id/moderation/notes')
  @ApiOperation({ summary: 'List moderation notes' })
  notes(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listNotes(id, q);
  }

  @Get(':id/moderation/reports')
  @ApiOperation({ summary: 'List reports' })
  reports(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listReports(id, q);
  }

  @Get(':id/moderation/appeals')
  @ApiOperation({ summary: 'List appeals' })
  appeals(@Param('id', ParseUuidPipe) id: string, @Query() q: ListModerationDto) {
    return this.moderation.listAppeals(id, q);
  }
}
