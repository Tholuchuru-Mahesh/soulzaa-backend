export const RELATIONSHIP_SERVICE = Symbol('RELATIONSHIP_SERVICE');

/**
 * Answers social-graph edge queries needed by the FriendsOnly / FollowersOnly
 * privacy levels. No social module exists yet, so a null stub is bound today;
 * a future friends/followers module rebinds RELATIONSHIP_SERVICE without any
 * change to the privacy check logic.
 */
export interface IRelationshipProvider {
  /** Are `a` and `b` mutual friends? */
  isFriend(a: string, b: string): Promise<boolean>;
  /** Does `viewer` follow `target`? */
  isFollower(viewer: string, target: string): Promise<boolean>;
}
