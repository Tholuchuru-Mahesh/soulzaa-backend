import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PresenceService } from 'src/infra/redis/presence.service';
import { INFRA_PRESENCE_EVENTS, PresenceChangedEvent } from 'src/infra/socket/presence.events';
import { GAME_DISCONNECT_GRACE_SECONDS } from '../constants/games.constants';
import { GamesService } from '../services/games.service';

/**
 * Auto-forfeits a player's active match when they fully disconnect — the infra
 * presence event fires once when a user's LAST socket (across all namespaces)
 * drops, i.e. the app-killed / lost-connection case.
 *
 * A brief network blip must NOT instantly forfeit/cancel the match (a bet-match
 * forfeit refunds + cancels the whole pot), so a disconnect only SCHEDULES the
 * forfeit after {@link GAME_DISCONNECT_GRACE_SECONDS}. If the player reconnects
 * within that window the pending forfeit is cancelled; when the timer does fire
 * it re-checks presence and skips the forfeit if they've since come back online.
 * `forfeitOnDisconnect` remains a no-op when the user isn't in an active session.
 */
@Injectable()
export class PresenceForfeitListener implements OnModuleInit, OnModuleDestroy {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly games: GamesService,
    private readonly presence: PresenceService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PresenceChangedEvent>(INFRA_PRESENCE_EVENTS.CHANGED, (e) => {
      const { userId, online } = e.payload;
      if (online) {
        this.cancelPending(userId); // reconnected within the grace window
        return;
      }
      this.scheduleForfeit(userId);
    });
  }

  /** Schedule a grace-delayed forfeit; a second offline event before it fires is ignored. */
  private scheduleForfeit(userId: string): void {
    if (this.pending.has(userId)) return;
    const graceMs = Math.max(0, GAME_DISCONNECT_GRACE_SECONDS) * 1000;
    const timer = setTimeout(() => {
      void this.fireForfeit(userId);
    }, graceMs);
    // Don't keep the event loop (or a test process) alive purely for this timer.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pending.set(userId, timer);
  }

  private cancelPending(userId: string): void {
    const timer = this.pending.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(userId);
    }
  }

  /** Grace expired: forfeit only if the player is STILL offline. */
  private async fireForfeit(userId: string): Promise<void> {
    this.pending.delete(userId);
    // Defensive re-check: if the reconnect (online) event was missed for any
    // reason, the presence store is the source of truth — never forfeit a
    // player who is actually back online.
    if (await this.presence.isOnline(userId)) return;
    void this.games.forfeitOnDisconnect(userId);
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
