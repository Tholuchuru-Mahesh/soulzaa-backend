import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMemberRole } from '@prisma/client';
import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { VideoRoomPermission } from '../constants/video-room-permissions';
import { GRANTABLE_VIDEO_ROOM_ROLES } from './grant-video-room-role.dto';

/** Revoke a user's elevated in-room grant. */
export class RemoveVideoRoomRoleDto {
  @ApiProperty({ description: 'The user whose grant is revoked.' })
  @IsUUID()
  userId!: string;
}

/** Replace a user's elevated grant with a different role and/or expiry. */
export class UpdateVideoRoomRoleDto {
  @ApiProperty({ description: 'The user whose grant changes.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: GRANTABLE_VIDEO_ROOM_ROLES,
    description:
      'OWNER is rejected — ownership is transferred, not assigned. HOST is rejected — it is derived from seat occupancy.',
  })
  @IsIn(GRANTABLE_VIDEO_ROOM_ROLES)
  role!: VideoRoomMemberRole;

  @ApiPropertyOptional({
    description: 'ISO-8601 expiry; omit for a permanent grant.',
    example: '2026-07-22T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

/** Hand room ownership to another active member. */
export class TransferVideoRoomOwnershipDto {
  @ApiProperty({ description: 'The active member who becomes the new owner.' })
  @IsUUID()
  newOwnerId!: string;
}

/** One elevated grant, as returned by GET /:id/roles. */
export class VideoRoomRoleResponseDto {
  @ApiProperty() userId!: string;

  @ApiProperty({ enum: VideoRoomMemberRole }) role!: VideoRoomMemberRole;

  @ApiProperty({ nullable: true, description: 'Who issued the grant.' })
  grantedBy!: string | null;

  @ApiProperty({ nullable: true, description: 'ISO-8601 expiry; null when permanent.' })
  expiresAt!: string | null;

  @ApiProperty({ description: 'True when the grant carries an expiry.' })
  temporary!: boolean;
}

/** The permission catalogue plus the role matrix, for clients rendering capability UI. */
export class VideoRoomPermissionCatalogueDto {
  @ApiProperty({ enum: VideoRoomPermission, isArray: true })
  permissions!: VideoRoomPermission[];

  @ApiProperty({
    description: 'Role → the permissions it holds.',
    example: {
      OWNER: ['MANAGE_ROOM', 'GRANT_ROLES', 'TRANSFER_OWNERSHIP'],
      ADMIN: ['MANAGE_SEATS', 'KICK_USERS'],
      VIEWER: [],
    },
  })
  matrix!: Record<VideoRoomMemberRole, VideoRoomPermission[]>;
}

/** The caller's own effective authority in a room. */
export class MyVideoRoomPermissionsDto {
  @ApiProperty({ enum: VideoRoomMemberRole, nullable: true })
  role!: VideoRoomMemberRole | null;

  @ApiProperty({ enum: VideoRoomPermission, isArray: true })
  permissions!: VideoRoomPermission[];

  @ApiProperty({ description: 'True when the caller holds a time-limited grant.' })
  temporary!: boolean;

  @ApiProperty({
    description: 'True when platform staff privileges are bypassing in-room checks.',
  })
  isPlatformAdmin!: boolean;
}
