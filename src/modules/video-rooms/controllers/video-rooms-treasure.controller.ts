import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { RequestId } from 'src/common/decorators/request-id.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateTreasureBoxDto,
  TreasureHistoryQueryDto,
  TreasureResponseDto,
  TreasureStatisticsDto,
  TreasureWinnerDto,
} from '../dto/video-room-treasure.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomTreasureQueryService } from '../services/video-room-treasure-query.service';
import { VideoRoomTreasureService } from '../services/video-room-treasure.service';

/**
 * VR-11 treasure REST surface (base `video-rooms/:id/treasure`).
 *
 * Lifecycle commands are synchronous and return the new session state. Unlocks
 * are NOT triggered here — they are driven by gift progress and delivered over
 * the socket — so there is deliberately no "open box" endpoint for a client to
 * call, and no way to mint a pool from the outside.
 *
 * JWT-guarded globally. Authorization lives in VideoRoomTreasureService and
 * VideoRoomTreasureQueryService (MANAGE_TREASURE / VIEW_ANALYTICS), never inline
 * here — the VR-10 controller convention.
 */
@ApiTags('video-room-treasure')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsTreasureController {
  constructor(
    private readonly lifecycle: VideoRoomTreasureService,
    private readonly query: VideoRoomTreasureQueryService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  private page(q: TreasureHistoryQueryDto): { skip: number; limit: number; page: number } {
    return { skip: (q.page - 1) * q.limit, limit: q.limit, page: q.page };
  }

  @Post(':id/treasure')
  @NotGuest()
  @ApiOperation({
    summary: 'Create a treasure ladder (DRAFT)',
    description:
      'Owner/admin only (MANAGE_TREASURE). Freezes the configured level ladder into ' +
      'the session, so a later admin edit cannot change the rules of a ladder players ' +
      'are already filling. Boxes are created PENDING — start the ladder to begin.',
  })
  @ApiParam({ name: 'id', description: 'Video room id (uuid)' })
  @ApiResponse({ status: 201, type: TreasureResponseDto })
  @ApiResponse({
    status: 403,
    description: 'VIDEO_ROOM_TREASURE_DISABLED — room disallows treasure',
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_ROOM_TREASURE_INVALID — a ladder already exists',
  })
  @ApiResponse({ status: 424, description: 'VIDEO_ROOM_TREASURE_INVALID — no levels configured' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: CreateTreasureBoxDto,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.create(this.actor(user), roomId, dto, requestId);
  }

  @Post(':id/treasure/start')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Start the ladder',
    description: 'DRAFT → ACTIVE; level 1 begins accumulating gift value. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_TREASURE_INVALID — not in DRAFT' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.start(this.actor(user), roomId, requestId);
  }

  @Post(':id/treasure/pause')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Pause contribution intake',
    description:
      'ACTIVE → PAUSED. Gifts still succeed but stop counting. A box already unlocking ' +
      'completes and still pays its winners — they were claimed before the pause. ' +
      'MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_TREASURE_INVALID — not ACTIVE' })
  pause(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.pause(this.actor(user), roomId, requestId);
  }

  @Post(':id/treasure/resume')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Resume intake', description: 'PAUSED → ACTIVE. MANAGE_TREASURE.' })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  @ApiResponse({ status: 409, description: 'VIDEO_ROOM_TREASURE_INVALID — not PAUSED' })
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.resume(this.actor(user), roomId, requestId);
  }

  @Post(':id/treasure/close')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'End the ladder early',
    description:
      'DRAFT/ACTIVE/PAUSED → CLOSED. Remaining boxes never unlock and nothing further ' +
      'is minted. Distinct from COMPLETED, which means the ladder ran to its end. ' +
      'MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.close(this.actor(user), roomId, requestId);
  }

  @Post(':id/treasure/archive')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({
    summary: 'Archive a finished ladder',
    description:
      'COMPLETED/CLOSED → ARCHIVED. Hidden from GET /treasure but still readable via ' +
      'history and winners, so the payout record survives. MANAGE_TREASURE.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  @ApiResponse({ status: 404, description: 'No ladder to archive' })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @RequestId() requestId?: string,
  ) {
    return this.lifecycle.archive(this.actor(user), roomId, requestId);
  }

  @Get(':id/treasure')
  @ApiOperation({
    summary: 'Current ladder state',
    description: 'Per-box progress, remaining coins and completion percentage. Any room member.',
  })
  @ApiResponse({ status: 200, type: TreasureResponseDto })
  status(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.status(roomId);
  }

  @Get(':id/treasure/history')
  @ApiOperation({
    summary: 'Past ladders in this room',
    description: 'Paginated, newest first. Any room member.',
  })
  @ApiResponse({ status: 200, description: 'Paginated envelope of past sessions' })
  history(@Param('id', ParseUuidPipe) roomId: string, @Query() q: TreasureHistoryQueryDto) {
    return this.query.history(roomId, this.page(q));
  }

  @Get(':id/treasure/winners')
  @ApiOperation({
    summary: 'Winner history',
    description:
      'Every drawn winner with the algorithm, share and eligibility counts that ' +
      'produced them — the audit view of who won and why. Paginated. Any room member.',
  })
  @ApiResponse({ status: 200, type: [TreasureWinnerDto] })
  winners(@Param('id', ParseUuidPipe) roomId: string, @Query() q: TreasureHistoryQueryDto) {
    return this.query.winners(roomId, this.page(q));
  }

  @Get(':id/treasure/statistics')
  @ApiOperation({
    summary: 'Room treasure statistics',
    description: 'Boxes unlocked, GOLD minted and winners paid. Requires VIEW_ANALYTICS.',
  })
  @ApiResponse({ status: 200, type: TreasureStatisticsDto })
  @ApiResponse({ status: 403, description: 'VIDEO_ROOM_FORBIDDEN' })
  statistics(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.query.statistics(this.actor(user), roomId);
  }
}
