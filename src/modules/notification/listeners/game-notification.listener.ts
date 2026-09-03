import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  GAME_EVENTS,
  type GameMatchFoundEvent,
  type GameSettledEvent,
} from 'src/modules/games/events/game.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/**
 * Game outcomes worth interrupting someone for.
 *
 * Only two events are subscribed, and the omissions are the design: lobby churn
 * (`LOBBY_JOINED`, `LOBBY_LEFT`, `LOBBY_MEMBER_READY`), turn traffic (`MOVE`,
 * `TURN_*`) and `MATCH_READY_PROGRESS` all fire while the player is staring at
 * the board. Those belong on the socket, and a notification for each would be
 * noise the user learns to swipe away — which costs us the ones that matter.
 *
 * Game coin payouts also arrive as `GAME_PAYOUT` wallet movements. That reason
 * is excluded from `WalletNotificationListener`'s allowlist precisely so a win
 * produces one notification here, not two.
 */
@Injectable()
export class GameNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GameMatchFoundEvent>(GAME_EVENTS.MATCH_FOUND, (e) => this.onMatchFound(e));
    this.bus.subscribe<GameSettledEvent>(GAME_EVENTS.SETTLED, (e) => this.onSettled(e));
  }

  // Notifications for games (Match found, Game won, Game lost) disabled per requirement.
  // In-game real-time socket events during active gameplay remain intact.
  private async onMatchFound(_e: GameMatchFoundEvent): Promise<void> {
    // Disabled: neither in-app nor push notification is dispatched for match found.
  }

  private async onSettled(_e: GameSettledEvent): Promise<void> {
    // Disabled: neither in-app nor push notification is dispatched for game settlement (won/lost).
  }
}
