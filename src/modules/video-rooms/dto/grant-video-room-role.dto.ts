import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMemberRole } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';

/** The elevated roles an owner/admin may grant (OWNER is not grantable — it is
 * transferred; VIEWER/PARTICIPANT are membership/seat-derived, not granted). */
export const GRANTABLE_VIDEO_ROOM_ROLES: VideoRoomMemberRole[] = [
  VideoRoomMemberRole.ADMIN,
  VideoRoomMemberRole.MODERATOR,
  VideoRoomMemberRole.HOST,
];

/**
 * Grant an elevated in-room role to a user. NOTE (VR-1): the endpoint returns 501
 * until the roles phase; this DTO defines the contract.
 */
export class GrantVideoRoomRoleDto {
  @ApiProperty({ description: 'The user receiving the grant.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: GRANTABLE_VIDEO_ROOM_ROLES })
  @IsIn(GRANTABLE_VIDEO_ROOM_ROLES)
  role!: VideoRoomMemberRole;

  @ApiPropertyOptional({ description: 'ISO-8601 expiry; omit for a permanent grant.' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
