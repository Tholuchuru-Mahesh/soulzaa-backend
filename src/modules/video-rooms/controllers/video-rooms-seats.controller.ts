import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
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
