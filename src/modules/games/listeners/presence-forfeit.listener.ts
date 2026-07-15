import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { INFRA_PRESENCE_EVENTS, PresenceChangedEvent } from 'src/infra/socket/presence.events';
import { GamesService } from '../services/games.service';

/**
 * Auto-forfeits a player's active match when they fully disconnect — the infra
 * presence event fires once when a user's LAST socket (across all namespaces)
 * drops, i.e. the app-killed / lost-connection case. `forfeitOnDisconnect` is a
 * no-op when the user isn't currently in an active session, so a random offline
 * event is harmless.
 */
@Injectable()
export class PresenceForfeitListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly games: GamesService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PresenceChangedEvent>(INFRA_PRESENCE_EVENTS.CHANGED, (e) => {
      if (!e.payload.online) void this.games.forfeitOnDisconnect(e.payload.userId);
    });
  }
}
