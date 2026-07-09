import type { VerificationType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * User/profile lifecycle events on the EVENT_BUS. A future Elasticsearch
 * indexer subscribes to `user.profile_updated`/`user.avatar_updated` to keep
 * the search index fresh; analytics/notifications consume verification events.
 */
export const USER_EVENTS = {
  PROFILE_UPDATED: 'user.profile_updated',
  AVATAR_UPDATED: 'user.avatar_updated',
  VERIFICATION_REQUESTED: 'user.verification_requested',
  VERIFIED: 'user.verified',
} as const;

export class UserProfileUpdatedEvent extends DomainEvent<{
  userId: string;
  username: string;
  changed: string[];
}> {
  readonly name = USER_EVENTS.PROFILE_UPDATED;
}

export class UserAvatarUpdatedEvent extends DomainEvent<{
  userId: string;
  kind: 'avatar' | 'cover';
  key: string;
}> {
  readonly name = USER_EVENTS.AVATAR_UPDATED;
}

export class UserVerificationRequestedEvent extends DomainEvent<{
  userId: string;
  type: VerificationType;
}> {
  readonly name = USER_EVENTS.VERIFICATION_REQUESTED;
}

export class UserVerifiedEvent extends DomainEvent<{
  userId: string;
  verified: boolean;
  reviewedBy: string;
}> {
  readonly name = USER_EVENTS.VERIFIED;
}
