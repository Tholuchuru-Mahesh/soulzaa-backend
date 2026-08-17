import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Reconciles a Moderator's operational RoleScope states to exactly this set. */
export class SetModeratorStatesDto {
  @ApiProperty({
    type: [String],
    example: ['123e4567-e89b-12d3-a456-426614174000'],
    description: 'State IDs this moderator is authorized to operate in. Replaces the current set.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  stateIds!: string[];
}
