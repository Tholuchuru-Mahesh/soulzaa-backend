/**
 * Inbound WebSocket payload shapes for the `/casino` gateway. These are plain
 * validation/documentation DTOs, not run through Nest's global HTTP
 * `ValidationPipe` (that pipe is wired for REST controllers in `main.ts`, not
 * the socket transport here) — `CasinoGateway` validates the payload itself
 * so a malformed message degrades to the shared `casino_error { message }`
 * event instead of an unhandled exception, matching how every other
 * validation failure in this module surfaces (see `CasinoError` in
 * `services/casino.service.ts`).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString } from 'class-validator';

/**
 * `place_casino_bet` (Greedy Food — sends `item`) and `place_lucky_fruit_bet`
 * (Lucky Fruit — sends `symbol`) share this one wire shape; the gateway reads
 * whichever of `item`/`symbol` the caller sent (`body.item ?? body.symbol`).
 * `clientBetId` is the per-tap stacking/dedupe anchor — see
 * `casinoBetIdempotencyKey` in `constants/casino.constants.ts` and
 * `PlaceBetInput.clientBetId` in `services/casino.service.ts`.
 */
export class PlaceCasinoBetDto {
  @ApiProperty({ description: 'The roundId the client believes is currently active.' })
  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @ApiPropertyOptional({ description: 'Greedy Food bet item, e.g. "crab".' })
  @IsOptional()
  @IsString()
  item?: string;

  @ApiPropertyOptional({ description: 'Lucky Fruit bet symbol, e.g. "muskmelon".' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiProperty({ description: 'Chip amount — must be one of the 5 whitelisted denominations.' })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({
    description:
      'Client-generated id for THIS tap. Reusing it makes a retry a no-op replay (same debit, ' +
      'same bet row); a fresh id on the same item stacks a second bet.',
  })
  @IsString()
  @IsNotEmpty()
  clientBetId!: string;
}
