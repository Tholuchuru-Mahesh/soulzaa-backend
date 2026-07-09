import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ConfigureLayoutDto } from '../dto/configure-layout.dto';
import { GrantRoleDto, RevokeRoleDto } from '../dto/grant-role.dto';
import { MoveSpeakerDto } from '../dto/move-speaker.dto';
import { SeatInviteDto } from '../dto/seat-invite.dto';
import { SeatRequestDto } from '../dto/seat-request.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsService } from '../services/audio-room-seats.service';

/**
 * AR-1 seat & role REST surface (base `rooms/:id/...`). JWT-guarded globally;
 * in-room permission checks live in the service. Literal seat sub-paths are
 * declared before the `:index` routes so param segments don't shadow them.
 */
@ApiTags('audio-room-seats')
@ApiBearerAuth()
@Controller('rooms')
export class AudioRoomSeatsController {
  constructor(private readonly seats: AudioRoomSeatsService) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Reads ----

  @Get(':id/stage')
  @ApiOperation({ summary: 'Get the stage: seats, queue and seat settings' })
  stage(@Param('id', ParseUuidPipe) id: string) {
    return this.seats.getStage(id);
  }

  @Get(':id/queue')
  @ApiOperation({ summary: 'Get the mic-request queue' })
  queue(@Param('id', ParseUuidPipe) id: string) {
    return this.seats.getQueue(id);
  }

  // ---- Layout ----

  @Patch(':id/seats/layout')
  @ApiOperation({ summary: 'Reconfigure the stage layout (manage seats)' })
  configureLayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: ConfigureLayoutDto,
  ) {
    return this.seats.configureLayout(this.actor(user), id, dto);
  }

  // ---- Requests (literal paths before :index) ----

  @Post(':id/seats/request')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Request a microphone / seat' })
  requestSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SeatRequestDto,
  ) {
    return this.seats.requestSeat(this.actor(user), id, dto);
  }

  @Delete(':id/seats/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel my pending seat request' })
  async cancelRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    await this.seats.cancelRequest(this.actor(user), id);
    return { cancelled: true };
  }

  @Post(':id/seats/requests/:requestId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a seat request (manage seats)' })
  async acceptRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
  ) {
    await this.seats.resolveRequest(this.actor(user), id, requestId, true);
    return { accepted: true };
  }

  @Post(':id/seats/requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a seat request (manage seats)' })
  async rejectRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
  ) {
    await this.seats.resolveRequest(this.actor(user), id, requestId, false);
    return { rejected: true };
  }

  // ---- Invitations ----

  @Post(':id/seats/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Invite a user to a seat (manage seats)' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SeatInviteDto,
  ) {
    return this.seats.invite(this.actor(user), id, dto);
  }

  @Post(':id/seats/invitations/:invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Accept a seat invitation' })
  async acceptInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
  ) {
    await this.seats.respondInvitation(this.actor(user), id, invitationId, true);
    return { accepted: true };
  }

  @Post(':id/seats/invitations/:invitationId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a seat invitation' })
  async rejectInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
  ) {
    await this.seats.respondInvitation(this.actor(user), id, invitationId, false);
    return { rejected: true };
  }

  // ---- Take / leave ----

  @Post(':id/seats/leave')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Leave my seat (step off the stage)' })
  async leaveSeat(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    await this.seats.leaveSeat(this.actor(user), id);
    return { left: true };
  }

  @Post(':id/seats/:index/take')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Take an open seat' })
  takeSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.seats.takeSeat(this.actor(user), id, index);
  }

  // ---- Seat lock / mute ----

  @Post(':id/seats/:index/lock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lock a seat (manage seats)' })
  lockSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.seats.setSeatLocked(this.actor(user), id, index, true);
  }

  @Post(':id/seats/:index/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock a seat (manage seats)' })
  unlockSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.seats.setSeatLocked(this.actor(user), id, index, false);
  }

  @Post(':id/seats/:index/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute a seat (mute users)' })
  muteSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.seats.setSeatMuted(this.actor(user), id, index, true);
  }

  @Post(':id/seats/:index/unmute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute a seat (mute users)' })
  unmuteSeat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.seats.setSeatMuted(this.actor(user), id, index, false);
  }

  // ---- Room mute ----

  @Post(':id/mute-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute the whole room (room mute)' })
  muteAll(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.seats.setRoomMuted(this.actor(user), id, true);
  }

  @Post(':id/unmute-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute the whole room (room mute)' })
  unmuteAll(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.seats.setRoomMuted(this.actor(user), id, false);
  }

  // ---- Speaker moderation ----

  @Post(':id/speakers/:userId/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a speaker to another seat (manage speakers)' })
  moveSpeaker(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: MoveSpeakerDto,
  ) {
    return this.seats.moveSpeaker(this.actor(user), id, userId, dto.toSeatIndex);
  }

  @Post(':id/speakers/:userId/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a speaker from the stage (manage speakers)' })
  async removeSpeaker(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ) {
    await this.seats.removeSpeaker(this.actor(user), id, userId);
    return { removed: true };
  }

  // ---- Role grants ----

  @Post(':id/roles/grant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant an elevated in-room role (grant roles)' })
  async grantRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: GrantRoleDto,
  ) {
    await this.seats.grantRole(this.actor(user), id, dto.userId, dto.role);
    return { granted: true };
  }

  @Post(':id/roles/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an elevated in-room role (grant roles)' })
  async revokeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RevokeRoleDto,
  ) {
    await this.seats.revokeRole(this.actor(user), id, dto.userId);
    return { revoked: true };
  }
}
