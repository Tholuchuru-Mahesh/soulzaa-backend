/**
 * HTTP DTOs for the audio-room casino-window REST surface (`CasinoRoomController`).
 * Unlike the socket `PlaceCasinoBetDto` (validated by the gateway itself), these
 * run through Nest's global HTTP ValidationPipe.
 */
import { ApiProperty } from '@nestjs/swagger';
import { CasinoGame } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { PlaceCasinoBetDto } from './casino.dto';

/**
 * `POST /casino/rooms/:roomId/window` — which Gold Coin game the room owner
 * wants to open a window for. Only the two house-banked games are valid.
 */
export class StartCasinoWindowDto {
  @ApiProperty({ enum: CasinoGame, description: 'The Gold Coin game to open in the room.' })
  @IsEnum(CasinoGame)
  game!: CasinoGame;
}

/**
 * `POST /casino/rooms/:roomId/bet` — a room-window bet. The window is
 * host-only, so the caller must be the window's `hostId`. Extends the socket
 * bet shape (roundId/item|symbol/amount/clientBetId) with the target game; the
 * existing `CasinoService.placeBet` stays the single authoritative betting path.
 */
export class PlaceRoomBetDto extends PlaceCasinoBetDto {
  @ApiProperty({ enum: CasinoGame, description: 'The Gold Coin game this bet targets.' })
  @IsEnum(CasinoGame)
  game!: CasinoGame;
}
