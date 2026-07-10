import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PresenceStatus } from '@prisma/client';
import { USER_ROOM_PREFIX } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  INFRA_PRESENCE_EVENTS,
  type PresenceChangedEvent,
} from 'src/infra/socket/presence.events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomJoinedEvent,
  type RoomLeftEvent,
} from 'src/modules/audio-rooms/events/audio-room.events';
import { SOCIAL_NAMESPACE, SOCIAL_SOCKET_EVENTS } from '../constants/social.constants';
import { PresenceStateRepository } from '../repositories/presence-state.repository';
import { SocialService } from '../services/social.service';

/**
 * Rich-presence orchestrator. Turns coarse online/offline (from the socket
 * layer) and room lifecycle (audio-room joined/left) into a durable presence
 * state + a targeted `presence:updated` fan-out to the subject's audience
 * (friends ∪ followers). Additional statuses (IN_GAME / IN_PK) are wired the
 * same way as game/PK events land. The legacy global `presence:online/offline`
 * broadcast is untouched.
 */
@Injectable()
export class PresenceListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    private readonly stateRepo: PresenceStateRepository,
    private readonly social: SocialService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PresenceChangedEvent>(INFRA_PRESENCE_EVENTS.CHANGED, (e) =>
      this.onOnlineChanged(e),
    );
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, (e) =>
      this.apply(e.payload.userId, { status: PresenceStatus.IN_ROOM, currentRoomId: e.payload.roomId }),
    );
    this.bus.subscribe<RoomLeftEvent>(AUDIO_ROOM_EVENTS.LEFT, (e) =>
      this.apply(e.payload.userId, { status: PresenceStatus.ONLINE, currentRoomId: null }),
    );
  }

  private onOnlineChanged(e: PresenceChangedEvent): Promise<void> {
    const { userId, online } = e.payload;
    return online
      ? this.apply(userId, { status: PresenceStatus.ONLINE, currentRoomId: null })
      : this.apply(userId, {
          status: PresenceStatus.OFFLINE,
          currentRoomId: null,
          lastSeenAt: new Date(),
        });
  }

  private async apply(
    userId: string,
    patch: { status: PresenceStatus; currentRoomId?: string | null; lastSeenAt?: Date | null },
  ): Promise<void> {
    const row = await this.stateRepo.upsert(userId, patch);
    const audience = await this.social.presenceAudienceIds(userId);
    const payload = {
      userId,
      status: row.status,
      currentRoomId: row.currentRoomId,
      lastSeenAt: row.lastSeenAt,
    };
    for (const audienceId of audience) {
      this.sockets.emitToNamespaceRoom(
        SOCIAL_NAMESPACE,
        `${USER_ROOM_PREFIX}${audienceId}`,
        SOCIAL_SOCKET_EVENTS.PRESENCE_UPDATED,
        payload,
      );
    }
  }
}
