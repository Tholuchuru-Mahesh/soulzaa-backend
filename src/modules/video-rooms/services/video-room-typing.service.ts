import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
import { ChatTypingStartedEvent, ChatTypingStoppedEvent } from '../events/video-room-chat.events';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatCacheService } from './video-room-chat-cache.service';
import { VideoRoomChatPolicyService } from './video-room-chat-policy.service';

/**
 * Typing indicators — entirely ephemeral, entirely Redis. Nothing is persisted:
 * a typing signal has no value one second after it stops being true.
 *
 * A forgotten "stop" (tab closed, network dropped, process killed) self-heals
 * because the roster entry carries an absolute expiry that any reader on any
 * instance prunes. There is no sweeper to run and nothing to leak.
 */
@Injectable()
export class VideoRoomTypingService {
  constructor(
    private readonly cache: VideoRoomChatCacheService,
    private readonly policy: VideoRoomChatPolicyService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  async start(actor: RoomActor, roomId: string): Promise<void> {
    await this.policy.assertActiveMember(roomId, actor.id);
    const { typingTtlSeconds } = loadVideoRoomChatConfig(this.config);
    await this.cache.markTyping(roomId, actor.id, typingTtlSeconds);
    await this.bus.publish(new ChatTypingStartedEvent({ roomId, userId: actor.id }));
  }

  async stop(actor: RoomActor, roomId: string): Promise<void> {
    await this.policy.assertActiveMember(roomId, actor.id);
    await this.cache.clearTyping(roomId, actor.id);
    await this.bus.publish(new ChatTypingStoppedEvent({ roomId, userId: actor.id }));
  }

  /** Currently-typing user ids (expired entries pruned on read). */
  roster(roomId: string): Promise<string[]> {
    return this.cache.readTyping(roomId, Date.now());
  }
}
