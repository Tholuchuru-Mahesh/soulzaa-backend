import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ConfigureSeatLayoutDto } from '../dto/seat-layout.dto';
import {
  CancelSeatInvitationDto,
  QueueResponseDto,
  SeatRequestListItemDto,
  UpdateSeatRequestDto,
} from '../dto/seat-queue.dto';
import {
  AcceptSeatInvitationDto,
  CancelReservationDto,
  CreateSeatRequestDto,
  CreateVideoRoomInvitationDto,
  LockSeatsDto,
  RejectSeatInvitationDto,
  ReserveSeatDto,
  SwitchSeatDto,
  TransferSeatDto,
  UnlockSeatsDto,
} from '../dto/seat.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomSeatInvitationService } from '../services/video-room-seat-invitation.service';
import { VideoRoomSeatQueueService } from '../services/video-room-seat-queue.service';
import { VideoRoomSeatRequestService } from '../services/video-room-seat-request.service';
import { VideoRoomSeatReservationService } from '../services/video-room-seat-reservation.service';
import { VideoRoomSeatService } from '../services/video-room-seat.service';

/**
 * Video Room multi-seat REST surface (VR-4). Command-in over REST; realtime fan-out
 * is EVENT_BUS → VideoRoomSeatSocketListener (no domain socket gateway). The global
 * JwtAuthGuard secures every route; state-changing routes deny guests (@NotGuest).
 * In-room RBAC + validation live in the services — the controller only marshals the
 * actor, room id, DTO, and client IP (threaded into the audit trail).
 */
@ApiTags('video-room-seats')
@ApiBearerAuth()
@Controller('video-rooms')
export class VideoRoomSeatsController {
  constructor(
    private readonly seats: VideoRoomSeatService,
    private readonly reservations: VideoRoomSeatReservationService,
    private readonly requests: VideoRoomSeatRequestService,
    private readonly invitations: VideoRoomSeatInvitationService,
    private readonly queue: VideoRoomSeatQueueService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Stage read ----

  @Get(':id/seats')
  @ApiOperation({ summary: 'Get the live seat stage (versioned snapshot + overlays)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'The seat stage.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  getStage(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.seats.getStage(this.actor(user), id);
  }

  @Get(':id/seats/requests')
  @NotGuest()
  @ApiOperation({
    summary: 'List pending seat requests in queue order (owner/admin; MANAGE_SEATS)',
    description:
      'Ordered by queue priority: VIP tier first, then arrival time, with a ' +
      'fairness cap that pins repeatedly-skipped viewers to the front. Each row ' +
      'carries its 1-based queue position.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [SeatRequestListItemDto] })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'MANAGE_SEATS required.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  listRequests(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.requests.listRequests(this.actor(user), id);
  }

  @Get(':id/seats/invitations')
  @NotGuest()
  @ApiOperation({ summary: 'List outstanding seat invitations (owner/admin; INVITE_USERS)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Invitations still PENDING or DELIVERED.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'INVITE_USERS required.' })
  listInvitations(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.invitations.listInvitations(this.actor(user), id);
  }

  @Get(':id/seats/queue')
  @NotGuest()
  @ApiOperation({
    summary: 'The seat queue and your own position in it (any active member)',
  })
  @ApiResponse({ status: HttpStatus.OK, type: QueueResponseDto })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'You must join the room first.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Room not found.' })
  async getQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<QueueResponseDto> {
    await this.queue.assertQueueAccess(id, user.id);
    const [entries, myPosition, size] = await Promise.all([
      this.queue.list(id),
      this.queue.position(id, user.id),
      this.queue.size(id),
    ]);
    return {
      size,
      entries: entries.map((e) => ({
        userId: e.userId,
        position: e.position,
        vipLevel: e.vipLevel,
      })),
      myPosition,
    };
  }

  // ---- Reservation ----

  @Post(':id/seats/reserve')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reserve a seat for a user (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Seat reserved.' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Seat taken / locked / already reserved.',
  })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Missing MANAGE_SEATS.' })
  reserve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ReserveSeatDto,
    @Ip() ip: string,
  ) {
    return this.reservations.reserve(
      this.actor(user),
      id,
      dto.seatIndex,
      dto.forUserId,
      dto.ttlSeconds,
      ip,
    );
  }

  @Delete(':id/seats/reserve')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a seat reservation (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Reservation cancelled.' })
  cancelReservation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CancelReservationDto,
    @Ip() ip: string,
  ) {
    return this.reservations.cancelReservation(this.actor(user), id, dto.seatIndex, ip);
  }

  // ---- Request workflow ----

  @Post(':id/seats/request')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a seat (a specific seat, or any)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request created.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'A pending request already exists.' })
  requestSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateSeatRequestDto,
    @Ip() ip: string,
  ) {
    return this.requests.request(this.actor(user), id, dto.seatIndex, ip);
  }

  @Delete(':id/seats/request')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel your own pending seat request' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request cancelled.' })
  cancelRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.requests.cancelRequest(this.actor(user), id, ip);
  }

  @Post(':id/seats/request/:requestId/approve')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a seat request (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request approved; requester seated.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Request not found / not pending.' })
  approveRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
    @Ip() ip: string,
  ) {
    return this.requests.approve(this.actor(user), id, requestId, ip);
  }

  @Post(':id/seats/request/:requestId/reject')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a seat request (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request rejected.' })
  rejectRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
    @Ip() ip: string,
  ) {
    return this.requests.reject(this.actor(user), id, requestId, ip);
  }

  @Patch(':id/seats/request')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the preferred seat on your own pending request' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Request updated.' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No pending request / seat not found.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'That seat is locked.' })
  updateRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateSeatRequestDto,
    @Ip() ip: string,
  ) {
    return this.requests.updateRequest(this.actor(user), id, dto.seatIndex, ip);
  }

  @Post(':id/seats/request/:requestId/retry')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a FAILED seat request (owner/admin; MANAGE_SEATS)',
    description:
      'Re-drives the seating pipeline for a request whose previous attempt threw. ' +
      'Bounded by attemptCount; once the budget is spent the request is terminal.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Retry succeeded; requester seated.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Not FAILED, or retries exhausted.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Request not found.' })
  retryRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
    @Ip() ip: string,
  ) {
    return this.requests.retry(this.actor(user), id, requestId, ip);
  }

  // ---- Invitation workflow ----

  @Post(':id/seats/invite')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invite a user onto a seat (owner/admin; INVITE_USERS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation sent.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Duplicate pending invitation.' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateVideoRoomInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.invite(this.actor(user), id, dto.inviteeUserId, dto.seatIndex, ip);
  }

  @Post(':id/seats/invite/accept')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a seat invitation (invitee) → take the seat' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation accepted; seated.' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Invitation expired / no longer pending.',
  })
  acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AcceptSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.accept(this.actor(user), id, dto.invitationId, ip);
  }

  @Post(':id/seats/invite/reject')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a seat invitation (invitee)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation rejected.' })
  rejectInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RejectSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.reject(this.actor(user), id, dto.invitationId, ip);
  }

  @Delete(':id/seats/invite')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an outstanding invitation (inviter/owner/admin; INVITE_USERS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation cancelled.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Invitation not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Invitation is no longer actionable.' })
  cancelInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CancelSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.cancel(this.actor(user), id, dto.invitationId, ip);
  }

  @Post(':id/seats/invite/:invitationId/ack')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge receipt of an invitation (invitee) → DELIVERED',
    description:
      'Idempotent. Powers the invitation delivery-rate metric and lets the inviter ' +
      'distinguish "not seen yet" from "seen and ignoring".',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Invitation marked delivered.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Only the invitee may acknowledge.' })
  ackInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
    @Ip() ip: string,
  ) {
    return this.invitations.acknowledge(this.actor(user), id, invitationId, ip);
  }

  @Post(':id/seats/invite/:invitationId/retry')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a FAILED invitation acceptance (invitee)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Retry succeeded; invitee seated.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Not FAILED, or retries exhausted.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Only the invitee may retry.' })
  retryInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
    @Ip() ip: string,
  ) {
    return this.invitations.retry(this.actor(user), id, invitationId, ip);
  }

  // ---- Room invitation workflow (VR-15) ----

  @Post(':id/invitations/room')
  @NotGuest()
  @ApiOperation({ summary: 'Invite a non-member into the room (owner/admin/mod; INVITE_USERS)' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Room invitation created; invitee notified.',
  })
  inviteToRoom(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateVideoRoomInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.inviteToRoom(this.actor(user), id, dto.inviteeUserId, ip);
  }

  @Post(':id/invitations/room/accept')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a room invitation (invitee) → gains private-room access on next join',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Room invitation accepted.' })
  acceptRoomInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AcceptSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.acceptRoomInvite(this.actor(user), id, dto.invitationId, ip);
  }

  @Post(':id/invitations/room/reject')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a room invitation (invitee)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Room invitation rejected.' })
  rejectRoomInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RejectSeatInvitationDto,
    @Ip() ip: string,
  ) {
    return this.invitations.rejectRoomInvite(this.actor(user), id, dto.invitationId, ip);
  }

  // ---- Lock / unlock (bulk-capable) ----

  @Post(':id/seats/lock')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock one or more seats (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Seats locked.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Cannot lock the owner seat.' })
  lock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: LockSeatsDto,
    @Ip() ip: string,
  ) {
    return this.seats.lockSeats(this.actor(user), id, dto.seatIndexes, dto.reason, ip);
  }

  @Post(':id/seats/unlock')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock one or more seats (owner/admin; MANAGE_SEATS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Seats unlocked.' })
  unlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UnlockSeatsDto,
    @Ip() ip: string,
  ) {
    return this.seats.unlockSeats(this.actor(user), id, dto.seatIndexes, ip);
  }

  // ---- Dynamic layout (VR-17) ----

  @Post(':id/seats/layout')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reshape the seat layout (owner/admin, MANAGE_SEATS, LIVE room only)',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'The new versioned seat stage.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'SEAT_LAYOUT_INVALID.' })
  configureLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ConfigureSeatLayoutDto,
    @Ip() ip: string,
  ) {
    return this.seats.configureLayout(
      this.actor(user),
      id,
      dto.hostSeatCount,
      dto.guestSeatCount ?? 0,
      ip,
    );
  }

  // ---- Switch / transfer ----

  @Post(':id/seats/switch')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move your own occupancy to another seat' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Switched seats.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Not seated / destination taken.' })
  switchSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SwitchSeatDto,
    @Ip() ip: string,
  ) {
    return this.seats.switchSeat(this.actor(user), id, dto.toSeatIndex, ip);
  }

  @Post(':id/seats/transfer')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move another user between seats (owner/admin; MANAGE_PARTICIPANTS)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'User transferred.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Destination taken (use force).' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Missing permission / cannot outrank target.',
  })
  transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: TransferSeatDto,
    @Ip() ip: string,
  ) {
    return this.seats.transferSeat(
      this.actor(user),
      id,
      dto.userId,
      dto.toSeatIndex,
      dto.fromSeatIndex,
      dto.force ?? false,
      ip,
    );
  }
}
