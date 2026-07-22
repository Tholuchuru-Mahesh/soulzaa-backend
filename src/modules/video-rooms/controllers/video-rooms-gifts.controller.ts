import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { SendVideoRoomGiftDto } from '../dto/send-video-room-gift.dto';
import { VideoRoomGiftHistoryDto } from '../dto/video-room-gift-query.dto';
import {
  ReverseVideoRoomGiftDto,
  VideoRoomGiftBreakdownDto,
  VideoRoomGiftComboDto,
  VideoRoomGiftResponseDto,
  VideoRoomGiftReversalDto,
  VideoRoomGiftStatisticsDto,
  VideoRoomRecentGiftDto,
} from '../dto/video-room-gift-response.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomGiftQueryService } from '../services/video-room-gift-query.service';
import { VideoRoomGiftReversalService } from '../services/video-room-gift-reversal.service';
import { VideoRoomGiftService } from '../services/video-room-gift.service';

/**
 * VR-10 gift REST surface (base `video-rooms/:id/gifts/...`).
 *
 * Sends are synchronous and ACID: the response is returned only after the coins
 * have moved and the ledger is written, so a 201 always means the gift is paid
 * for. Animation delivery happens asynchronously afterwards over the socket.
 *
 * JWT-guarded globally. Authorization lives in the gift context handler
 * (membership + room settings) and, for the analytics breakdown, in
 * VideoRoomPermissionService — never inline here.
 */
@ApiTags('video-room-gifts')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomsGiftsController {
  constructor(
    private readonly gifts: VideoRoomGiftService,
    private readonly query: VideoRoomGiftQueryService,
    private readonly reversals: VideoRoomGiftReversalService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  @Post(':id/gifts/send')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({
    summary: 'Send a gift in a video room',
    description:
      'Charges coinValue x quantity x recipients in one atomic transaction: one debit, ' +
      'one credit per recipient, one ledger row per recipient, all sharing a batchId. ' +
      'All-or-nothing — if any recipient fails validation nothing is charged. ' +
      'Supply idempotencyKey to make a retry safe: a replay returns the original ' +
      'transactions instead of charging again.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video room id.' })
  @ApiResponse({
    status: 201,
    type: VideoRoomGiftResponseDto,
    description: 'Gift sent. Returns the batch and its per-recipient transactions.',
  })
  @ApiResponse({
    status: 400,
    description:
      'GIFT_RECEIVER_INVALID · GIFT_TOO_MANY_RECEIVERS · CANNOT_GIFT_SELF · GIFT_CONTEXT_INVALID',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({
    status: 403,
    description:
      'VIDEO_ROOM_GIFTS_DISABLED · VIDEO_ROOM_BLOCKED · NOT_ROOM_MEMBER · GIFT_VIP_RESTRICTED',
  })
  @ApiResponse({ status: 404, description: 'GIFT_NOT_FOUND · VIDEO_ROOM_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'GIFT_DISABLED · GIFT_CONTEXT_INVALID (room not live) · INSUFFICIENT_BALANCE',
  })
  @ApiResponse({ status: 429, description: 'GIFT_RATE_LIMITED' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Body() dto: SendVideoRoomGiftDto,
  ) {
    return this.gifts.send(this.actor(user), roomId, dto);
  }

  @Get(':id/gifts/history')
  @ApiOperation({
    summary: 'Paginated gift history for a room',
    description: 'Reads the immutable gift ledger scoped to this room. Filters combine with AND.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Paginated gift transactions, newest first.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  history(@Param('id', ParseUuidPipe) roomId: string, @Query() query: VideoRoomGiftHistoryDto) {
    return this.query.history(roomId, query);
  }

  @Get(':id/gifts/recent')
  @ApiOperation({
    summary: 'Recent gifts in a room',
    description:
      'Live newest-first feed served from Redis for the in-room gift ticker. Returns an ' +
      'empty list on a cold cache — this is a live view, not a historical record. Use ' +
      '/gifts/history for the durable ledger.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({
    status: 200,
    type: [VideoRoomRecentGiftDto],
    description: 'Recent gifts, newest first.',
  })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  recent(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.recent(roomId);
  }

  @Get(':id/gifts/combo')
  @ApiOperation({
    summary: 'Active gift combos in a room',
    description:
      'Live combo streaks. comboTier is presentation only — it never multiplies gift cost.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: [VideoRoomGiftComboDto], description: 'Active combos.' })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  combos(@Param('id', ParseUuidPipe) roomId: string) {
    return this.query.combos(roomId);
  }

  @Get(':id/gifts/statistics')
  @ApiOperation({
    summary: 'Gift statistics for a room',
    description:
      'Any member receives the summary (totals, top gifts, top senders). Holders of ' +
      'VIEW_ANALYTICS additionally receive the breakdown: per-receiver earnings, ' +
      'per-sender totals and unique sender count, aggregated from the ledger.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({
    status: 200,
    schema: {
      oneOf: [
        { $ref: '#/components/schemas/VideoRoomGiftStatisticsDto' },
        { $ref: '#/components/schemas/VideoRoomGiftBreakdownDto' },
      ],
    },
    description: 'Summary for members; breakdown for VIEW_ANALYTICS holders.',
  })
  @ApiExtraModels(VideoRoomGiftStatisticsDto, VideoRoomGiftBreakdownDto)
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  statistics(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) roomId: string) {
    return this.query.statisticsFor(roomId, this.actor(user));
  }

  // ---- Admin corrections (brief: TRANSACTION TYPES) ----

  @Post(':id/gifts/:transactionId/reverse')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse a single gift transaction (admin)',
    description:
      'Refunds the sender, claws the earnings back from the receiver, and marks the ledger ' +
      'row REVERSED. The row is never deleted, so history stays truthful. Idempotent on the ' +
      'transaction id: replaying a reversal cannot double-refund.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video room id.' })
  @ApiParam({ name: 'transactionId', format: 'uuid', description: 'Gift transaction to reverse.' })
  @ApiResponse({ status: 200, type: VideoRoomGiftReversalDto })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — platform admin only' })
  @ApiResponse({ status: 404, description: 'GIFT_TRANSACTION_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description:
      'GIFT_ALREADY_REVERSED · INSUFFICIENT_BALANCE (receiver already spent the earnings)',
  })
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('transactionId', ParseUuidPipe) transactionId: string,
    @Body() dto: ReverseVideoRoomGiftDto,
  ) {
    return this.reversals.reverseTransaction(roomId, transactionId, user.id, dto.reason);
  }

  @Post(':id/gifts/batches/:batchId/reverse')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse every leg of a gift batch (admin)',
    description:
      'A multi-recipient send was one user action and one charge, so it reverses as a unit — ' +
      'partially reversing it would leave the sender out of pocket for something they did not do.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video room id.' })
  @ApiParam({ name: 'batchId', format: 'uuid', description: 'Batch to reverse.' })
  @ApiResponse({ status: 200, type: [VideoRoomGiftReversalDto] })
  @ApiResponse({ status: 401, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 403, description: 'FORBIDDEN — platform admin only' })
  @ApiResponse({ status: 404, description: 'GIFT_TRANSACTION_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'GIFT_ALREADY_REVERSED · INSUFFICIENT_BALANCE' })
  reverseBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('batchId', ParseUuidPipe) batchId: string,
    @Body() dto: ReverseVideoRoomGiftDto,
  ) {
    return this.reversals.reverseBatch(roomId, batchId, user.id, dto.reason);
  }
}
