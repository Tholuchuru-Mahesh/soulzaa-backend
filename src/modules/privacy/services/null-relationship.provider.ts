import { Injectable } from '@nestjs/common';
import type { IRelationshipProvider } from '../interfaces/relationship-provider.interface';

/**
 * Placeholder relationship provider — no social graph exists yet. Everyone is
 * treated as neither a friend nor a follower, so FriendsOnly/FollowersOnly
 * privacy levels deny until a real friends/followers module rebinds
 * RELATIONSHIP_SERVICE. Keeps the privacy check logic complete today.
 */
@Injectable()
export class NullRelationshipProvider implements IRelationshipProvider {
  async isFriend(_a: string, _b: string): Promise<boolean> {
    return false;
  }

  async isFollower(_viewer: string, _target: string): Promise<boolean> {
    return false;
  }
}
