import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomCreatedEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import { INTERACTION_WEIGHTS } from '../constants/social.constants';
import { FriendshipRepository } from '../repositories/friendship.repository';
import { TrendingHostsStore } from '../services/trending-hosts.store';

/**
 * Feeds the social graph with interaction signals from existing domain events:
 *  - a gift accrues interaction score onto the sender↔receiver friendship (used
 *    for derived best-friends), a no-op if they aren't friends,
 *  - opening a room bumps the host in the trending-hosts set (recommendations).
 * Purely additive; owns no realtime output.
 */
@Injectable()
export class InteractionListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly friendships: FriendshipRepository,
    private readonly trending: TrendingHostsStore,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) =>
      this.friendships.bumpInteraction(
        e.payload.senderId,
        e.payload.receiverId,
        INTERACTION_WEIGHTS.GIFT,
      ),
    );
    this.bus.subscribe<RoomCreatedEvent>(AUDIO_ROOM_EVENTS.CREATED, (e) =>
      this.trending.bump(e.payload.ownerId),
    );
  }
}
