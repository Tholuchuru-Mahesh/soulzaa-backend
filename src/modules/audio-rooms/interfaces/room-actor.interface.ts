import type { PlatformRole } from '@prisma/client';

/**
 * The acting user for a room command, as read from the access token. Carries
 * platform roles so services can grant platform ADMIN/SUPER_ADMIN an override
 * over in-room permission checks.
 */
export interface RoomActor {
  id: string;
  roles: PlatformRole[];
}
