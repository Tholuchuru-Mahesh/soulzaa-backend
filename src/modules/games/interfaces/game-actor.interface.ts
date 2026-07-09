import type { PlatformRole } from 'src/common/constants';

/** The minimal actor identity a controller passes into the games service. */
export interface GameActor {
  id: string;
  roles: PlatformRole[];
}
