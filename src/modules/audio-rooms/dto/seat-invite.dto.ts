import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

/** Owner/admin invites a user to take a seat. Omit `seatIndex` for any open speaker seat. */
export class SeatInviteDto {
  @ApiProperty({ description: 'User to invite onto the stage.' })
  @IsUUID()
  userId!: string;

  @ApiPropertyOptional({
    description: 'Target seat index; omit for any available speaker seat.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  seatIndex?: number;
}
