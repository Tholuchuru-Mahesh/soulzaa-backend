import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/** Move a speaker from their current seat to another seat (owner/admin action). */
export class MoveSpeakerDto {
  @ApiProperty({ description: 'Destination seat index.', minimum: 0 })
  @IsInt()
  @Min(0)
  toSeatIndex!: number;
}
