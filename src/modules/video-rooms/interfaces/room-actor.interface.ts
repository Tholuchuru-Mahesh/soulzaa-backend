import type { PlatformRole } from '@prisma/client';

/**
 * The acting user for a video-room command, as read from the access token. Carries
 * platform roles so services can grant platform ADMIN / SUPER_ADMIN an override over
 * in-room permission checks. Own copy (not imported from audio-rooms) so the module
 * boundary stays clean — video-rooms depends only on common/infra/its own tree.
 */
export interface RoomActor {
  id: string;
  roles: PlatformRole[];
}
