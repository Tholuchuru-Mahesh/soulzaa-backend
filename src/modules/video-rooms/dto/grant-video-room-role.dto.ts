import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMemberRole } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * The elevated roles that may be granted. OWNER is not grantable — it is
 * transferred (POST /owner/transfer). HOST is not grantable either (VR-7): it is
 * derived from seat occupancy by `resolveEffectiveRole`, so a grantable HOST
 * could hold the role with no seat, diverging from the seat stage that VR-4/VR-5
 * treat as authoritative. VIEWER/PARTICIPANT are membership/seat-derived.
 */
export const GRANTABLE_VIDEO_ROOM_ROLES: VideoRoomMemberRole[] = [
  VideoRoomMemberRole.ADMIN,
  VideoRoomMemberRole.MODERATOR,
];

/** Grant an elevated in-room role to a user (VR-7: served by VideoRoomRoleService). */
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
