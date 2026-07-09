import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Min } from 'class-validator';

/** Set the watch-party video (YouTube id). */
export class SetVideoDto {
  @ApiProperty({ description: 'YouTube video id (11 chars).' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{11}$/, { message: 'Invalid YouTube video id.' })
  videoId!: string;
}

/** Seek the watch party to a position (seconds). */
export class SeekDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  positionSeconds!: number;
}
