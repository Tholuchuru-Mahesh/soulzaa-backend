import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/** A listener's microphone (seat) request. Omit `seatIndex` for any open speaker seat. */
export class SeatRequestDto {
  @ApiPropertyOptional({
    description: 'Preferred seat index; omit for any available speaker seat.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  seatIndex?: number;

  @ApiPropertyOptional({
    description: 'Request type: BECOME_SPEAKER or REQUEST_TO_SPEAK',
    default: 'BECOME_SPEAKER',
  })
  @IsOptional()
  type?: string;
}
