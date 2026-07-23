import { DomainEvent } from 'src/common/events';
import { VIDEO_ROOM_ECONOMY_EVENTS } from '../constants/video-room-economy.constants';

/** Sender/context of a failed video-room economy operation (e.g. gift send). */
export interface VideoRoomEconomyFailedPayload {
  userId: string;
  roomId: string;
  giftId: string;
  errorCode: string;
  message: string;
}

/**
 * App-layer failure event: a video-room coin operation threw and rolled back, so
 * no wallet event fired. Published by the failing operation, bridged to the
 * `transactionFailed` socket event by VideoRoomEconomySocketListener.
 */
export class VideoRoomEconomyFailedEvent extends DomainEvent<VideoRoomEconomyFailedPayload> {
  readonly name = VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED;
}
