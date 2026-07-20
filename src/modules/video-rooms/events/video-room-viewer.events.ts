import { DomainEvent } from 'src/common/events';
import type { ViewerStatus } from '../enums';
import { VIDEO_ROOM_EVENTS } from './video-room.events';

/** A viewer was seated (host-direct promotion). */
export class ViewerPromotedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  seatIndex: number;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_PROMOTED;
}

/** A participant was returned to the audience (demotion). */
export class ViewerDemotedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  actorId: string;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_DEMOTED;
}

/** A viewer's presence label changed (coalesced by the caller). */
export class ViewerPresenceChangedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  status: ViewerStatus;
  audienceCount: number;
}> {
  readonly name = VIDEO_ROOM_EVENTS.VIEWER_PRESENCE_CHANGED;
}
