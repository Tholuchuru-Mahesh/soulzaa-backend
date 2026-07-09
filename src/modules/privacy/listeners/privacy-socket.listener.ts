import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  PRIVACY_EVENTS,
  type PrivacyUpdatedEvent,
  type UserBlockedEvent,
  type UserUnblockedEvent,
} from '../events/privacy.events';

/**
 * Realtime privacy sync: pushes settings/preferences changes to a user's own
 * sockets so clients re-render immediately, and notifies both parties of a
 * block/unblock (so a blocked user can drop cached data about the blocker).
 * Mirrors the session socket listener; uses the serverless
 * SocketManager.emitToUserEverywhere.
 */
@Injectable()
export class PrivacySocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PrivacyUpdatedEvent>(PRIVACY_EVENTS.UPDATED, (event) => {
      this.sockets.emitToUserEverywhere(event.payload.userId, 'privacy:updated', {
        kind: event.payload.kind,
        changed: event.payload.changed,
      });
    });

    const onBlockChange = (blockerId: string, blockedId: string, blocked: boolean) => {
      const payload = { blockerId, blockedId, blocked };
      this.sockets.emitToUserEverywhere(blockerId, 'privacy:block-changed', payload);
      this.sockets.emitToUserEverywhere(blockedId, 'privacy:block-changed', payload);
    };

    this.bus.subscribe<UserBlockedEvent>(PRIVACY_EVENTS.USER_BLOCKED, (e) =>
      onBlockChange(e.payload.blockerId, e.payload.blockedId, true),
    );
    this.bus.subscribe<UserUnblockedEvent>(PRIVACY_EVENTS.USER_UNBLOCKED, (e) =>
      onBlockChange(e.payload.blockerId, e.payload.blockedId, false),
    );
  }
}
