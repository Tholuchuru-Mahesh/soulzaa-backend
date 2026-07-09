import { DomainEvent } from 'src/common/events';

export const FAMILY_EVENTS = {
  CREATED: 'family.created',
  DELETED: 'family.deleted',
  MEMBER_JOINED: 'family.member_joined',
  MEMBER_LEFT: 'family.member_left',
} as const;

export class FamilyCreatedEvent extends DomainEvent<{
  familyId: string;
  name: string;
  leaderId: string;
}> {
  readonly name = FAMILY_EVENTS.CREATED;
}

export class FamilyDeletedEvent extends DomainEvent<{
  familyId: string;
  leaderId: string;
}> {
  readonly name = FAMILY_EVENTS.DELETED;
}

export class FamilyMemberJoinedEvent extends DomainEvent<{
  familyId: string;
  userId: string;
}> {
  readonly name = FAMILY_EVENTS.MEMBER_JOINED;
}

export class FamilyMemberLeftEvent extends DomainEvent<{
  familyId: string;
  userId: string;
  kicked: boolean;
  actorId: string;
}> {
  readonly name = FAMILY_EVENTS.MEMBER_LEFT;
}
