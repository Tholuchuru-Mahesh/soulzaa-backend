import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { PRESENCE_QUERY_MAX } from '../constants/social.constants';

/** Batch presence lookup. `userIds` accepts a comma-separated list or repeats. */
export class PresenceQueryDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(PRESENCE_QUERY_MAX)
  @IsUUID('all', { each: true })
  userIds!: string[];
}
