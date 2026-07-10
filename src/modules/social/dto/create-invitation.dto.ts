import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvitationType } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';

/** Invite a user to a resource (room/game/family/PK/event). */
export class CreateInvitationDto {
  @ApiProperty({ enum: InvitationType })
  @IsEnum(InvitationType)
  type!: InvitationType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  inviteeUserId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Resource id (roomId/gameId/...)' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ type: Object, description: 'Display metadata resolved at send time' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
