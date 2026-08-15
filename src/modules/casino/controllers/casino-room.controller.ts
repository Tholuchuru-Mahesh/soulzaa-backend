/**
 * REST surface for audio-room casino windows — the room-scoped, host-only
 * counterpart to the global `/casino` socket table. All four routes are gated
 * server-side by room ownership/membership (never by client UI):
 *   - start window: room owner only, room live, one-active-game-per-room.
 *   - close window: room owner only.
 *   - bet: the window's host only (room members spectate but cannot bet).
 *   - window detail: active room members only (the authoritative sync snapshot).
 *
 * Real-time follow-up comes over the socket: members `room:join` the window's
 * session id on `/games` (admitted as `'spectator'`) and receive the mirror
 * feed (`RoomCasinoWindowListener`).
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { PlaceRoomBetDto, StartCasinoWindowDto } from '../dto/casino-window.dto';
import { RoomCasinoWindowService } from '../services/room-casino-window.service';

@ApiTags('casino')
@ApiBearerAuth()
@Controller('casino')
export class CasinoRoomController {
  constructor(private readonly windows: RoomCasinoWindowService) {}

  @Post('rooms/:roomId/window')
  @HttpCode(HttpStatus.CREATED)
  @NotGuest()
  @ApiOperation({ summary: 'Open a Gold Coin game window in the room (room owner only)' })
  startWindow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Body() dto: StartCasinoWindowDto,
  ) {
    return this.windows.startWindow(roomId, user.id, dto.game);
  }

  @Get('rooms/:roomId/window')
  @NotGuest()
  @ApiOperation({
    summary: 'Room casino-window snapshot (current room members only) — the join-sync payload',
  })
  windowDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
  ) {
    return this.windows.getWindow(roomId, user.id);
  }

  @Delete('rooms/:roomId/window')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Close the room casino window (room owner only)' })
  closeWindow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
  ) {
    return this.windows.closeWindow(roomId, user.id);
  }

  @Post('rooms/:roomId/bet')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Place a bet on the room casino window (window host only)' })
  placeBet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUuidPipe) roomId: string,
    @Body() dto: PlaceRoomBetDto,
  ) {
    return this.windows.placeHostBet(roomId, user.id, dto);
  }
}
