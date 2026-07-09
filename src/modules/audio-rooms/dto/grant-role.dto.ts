import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

/** Elevated in-room roles that can be granted/revoked (stored in room_roles). */
export const GRANTABLE_ROLES = ['ADMIN', 'PREMIUM_ADMIN'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/** Grant an elevated room role to a member (owner/admin action). */
export class GrantRoleDto {
  @ApiProperty({ description: 'Member to grant the role to.' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    enum: GRANTABLE_ROLES,
    description: 'ADMIN or PREMIUM_ADMIN. OWNER is set only via transfer.',
  })
  @IsIn(GRANTABLE_ROLES)
  role!: GrantableRole;
}

/** Revoke a member's elevated room role (demote to listener/audience). */
export class RevokeRoleDto {
  @ApiProperty({ description: 'Member whose elevated role is revoked.' })
  @IsUUID()
  userId!: string;
}
