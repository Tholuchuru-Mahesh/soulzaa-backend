import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestId } from 'src/common/decorators/request-id.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AcceptPKInvitationDto,
  CreatePKInvitationDto,
  EndPKDto,
  PausePKDto,
  PKHistoryQueryDto,
  PKResponseDto,
  PKStatisticsDto,
  RejectPKInvitationDto,
  ResumePKDto,
  StartPKDto,
} from '../dto/video-room-pk.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomPkQueryService } from '../services/video-room-pk-query.service';
import { VideoRoomPkService } from '../services/video-room-pk.service';

/**
 * VR-12 PK battle REST surface (base `video-rooms/:id/pk`).
 *
 * Lifecycle commands (`invite`/`accept`/`reject`/`cancel`/`start`/`pause`/
 * `resume`/`end`) are synchronous — the response is the battle's new state,
 * not a job handle. Score updates and countdown/timer ticks are NOT polled
 * here: they are driven by gift progress and the recovery/timer sweeps and
 * delivered over the socket, so there is deliberately no "tick" endpoint.
 *
 * JWT-guarded globally. Authorization lives entirely in
 * `VideoRoomPkValidationService` (via `VideoRoomPkService`'s
 * `assertCanCreate`/`assertCanManage`), in `VideoRoomPkInvitationService`
 * (accept/reject authorise on being the named invitee, not a room role), and
 * in `VideoRoomPkQueryService` (`VIEW_ANALYTICS` for statistics) — never
 * inline here. This is the VR-10/VR-11 controller convention.
 */
@ApiTags('video-room-pk')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsPkController {
  constructor(
    private readonly lifecycle: VideoRoomPkService,
    private readonly query: VideoRoomPkQueryService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/pk/invite')
  @NotGuest()
  @ApiOperation({
    summary: 'Invite participants to a PK battle',
    description:
      'Owner/admin only (START_PK). Freezes the scoring/reward rules into the battle, ' +
      'creates the two teams and their participants, and sends one invitation per ' +
      'invitee. The battle starts CREATED and moves to INVITED once invitations are sent.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 201, type: PKResponseDto })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_PK_DISABLED — the PK engine is off globally or in this room; or ' +
      'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK',
  })
  @ApiResponse({ status: 404, description: 'VIDEO_ROOM_NOT_FOUND — room does not exist' })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_ROOM_PK_INVALID — participants overlap sides, are duplicated, violate the ' +
      "mode's per-side cardinality, or are not an active, non-viewer member",
  })
  @ApiResponse({
    status: 409,
    description:
      'VIDEO_ROOM_PK_INVALID — room is not LIVE, or a participant is not online or not ' +
      'publishing media; or VIDEO_ROOM_PK_ALREADY_ACTIVE — a battle is already in progress',
  })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: CreatePKInvitationDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.invite(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/accept')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Accept a PK invitation',
    description:
      'No room permission is checked — authority is being the named invitee. Advances ' +
      'the battle to ACCEPTED once every invitee has responded. When `battleId` is ' +
      "omitted the room's current battle is used.",
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_PK_INVITATION_FAILED — no pending invitation for this actor on this battle',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_ROOM_PK_INVALID — no battle found (explicit id, or no current battle)',
  })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: AcceptPKInvitationDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.accept(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/reject')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Reject a PK invitation',
    description:
      'No room permission is checked — authority is being the named invitee. The battle ' +
      'moves to CANCELLED once nothing remains actionable. When `battleId` is omitted ' +
      "the room's current battle is used.",
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_PK_INVITATION_FAILED — no pending invitation for this actor on this battle',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_ROOM_PK_INVALID — no battle found (explicit id, or no current battle)',
  })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: RejectPKInvitationDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.reject(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/cancel')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Cancel the current PK battle',
    description:
      'Owner/admin only (START_PK). Cancels every outstanding invitation and moves the ' +
      'battle straight to CANCELLED from whatever pre-LIVE state it is in.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_ROOM_NOT_FOUND — room does not exist; or VIDEO_ROOM_PK_INVALID — no PK ' +
      'battle is in progress in this room',
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.cancel(this.actor(user), roomId, requestId);
  }

  @Post(':id/pk/start')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Start the PK battle countdown',
    description:
      'Owner/admin only (START_PK). ACCEPTED → COUNTDOWN; every invitee must already ' +
      'have accepted.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_ROOM_NOT_FOUND — room does not exist; or VIDEO_ROOM_PK_INVALID — no PK ' +
      'battle is in progress in this room',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_PK_INVALID — the battle is not ACCEPTED',
  })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: StartPKDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.start(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/pause')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Pause a live PK battle',
    description: 'Owner/admin only (START_PK). LIVE → PAUSED; remaining time is preserved.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_ROOM_NOT_FOUND — room does not exist; or VIDEO_ROOM_PK_INVALID — no PK ' +
      'battle is in progress in this room',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_PK_INVALID — the battle is not LIVE',
  })
  pause(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: PausePKDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.pause(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/resume')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Resume a paused PK battle',
    description:
      'Owner/admin only (START_PK). PAUSED → LIVE; `endsAt` is recomputed from the ' +
      'remaining time banked at pause.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_ROOM_NOT_FOUND — room does not exist; or VIDEO_ROOM_PK_INVALID — no PK ' +
      'battle is in progress in this room',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_PK_INVALID — the battle is not PAUSED',
  })
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: ResumePKDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.resume(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/pk/end')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'End the PK battle early',
    description:
      'Owner/admin only (START_PK). LIVE/PAUSED → COMPLETED via settlement (winner ' +
      'computation and reward payout).',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks START_PK' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_ROOM_NOT_FOUND — room does not exist; or VIDEO_ROOM_PK_INVALID — no PK ' +
      'battle is in progress in this room',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_PK_INVALID — the battle is not LIVE or PAUSED',
  })
  @ApiResponse({
    status: 501,
    description: 'VIDEO_ROOM_PK_INVALID — settlement is not available yet',
  })
  end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: EndPKDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.end(this.actor(user), roomId, dto, requestId);
  }

  @Get(':id/pk/history')
  @ApiOperation({
    summary: 'Past PK battles in this room',
    description: 'Terminal battles only (COMPLETED/CANCELLED/FAILED), paginated. Any room member.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, description: 'Paginated envelope of past battles' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Query() q: PKHistoryQueryDto,
  ) {
    return this.query.history(this.actor(user), roomId, q);
  }

  @Get(':id/pk/statistics')
  @ApiOperation({
    summary: 'Room PK statistics',
    description:
      'All-time battle/win/draw counts and contributed coins for this room. Requires ' +
      'VIEW_ANALYTICS.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKStatisticsDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN — actor lacks VIEW_ANALYTICS' })
  statistics(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.query.statistics(this.actor(user), roomId);
  }

  @Get(':id/pk')
  @ApiOperation({
    summary: 'Current PK battle state',
    description:
      "Teams, per-participant scores and timing for the room's active battle, or " +
      '`{ active: false }` when none is in progress. Any room member.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 200, type: PKResponseDto })
  getCurrent(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.getCurrent(roomId);
  }
}
