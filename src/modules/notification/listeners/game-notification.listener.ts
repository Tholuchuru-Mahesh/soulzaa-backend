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

  private async onMatchFound(e: GameMatchFoundEvent): Promise<void> {
    const { matchId, gameCode, stake, players } = e.payload;

    await Promise.all(
      players.map((userId) =>
        this.guard.once(`game-match:${matchId}:${userId}`, GUARD_TTL.GAME_SESSION, async () => {
          await this.notifications.create({
            userId,
            type: NotificationType.GAME_MATCH_FOUND,
            entityType: 'game_match',
            entityId: matchId,
            data: { gameCode, stake },
          });

          await this.notifications.notify(userId, {
            category: PUSH_CATEGORIES.GAME,
            title: 'Match found',
            body: `Your ${gameCode} match is ready — tap to join`,
            threadId: `game_${userId}`,
            badge: 'unread',
            data: { type: 'game_match_found', matchId, gameCode: String(gameCode) },
          });
        }),
      ),
    );
  }

  private async onSettled(e: GameSettledEvent): Promise<void> {
    const { sessionId, gameCode, winners, participants, payouts } = e.payload;

    const won = new Set(winners);
    const payoutFor = new Map(payouts.map((p) => [p.userId, p.amount]));

    await Promise.all(
      participants.map((userId) =>
        this.guard.once(`game:${sessionId}:${userId}`, GUARD_TTL.GAME_SESSION, async () => {
          const isWinner = won.has(userId);
          const amount = payoutFor.get(userId) ?? 0;

          await this.notifications.create({
            userId,
            type: isWinner ? NotificationType.GAME_WON : NotificationType.GAME_LOST,
            entityType: 'game_session',
            entityId: sessionId,
            data: { gameCode, amount, won: isWinner },
          });

          await this.notifications.notify(userId, {
            category: PUSH_CATEGORIES.GAME,
            title: isWinner ? 'You won!' : 'Game over',
            body: isWinner
              ? `You won ${amount} coins in ${gameCode}`
              : `Better luck next time in ${gameCode}`,
            threadId: `game_${userId}`,
            badge: 'unread',
            data: { type: 'game_settled', sessionId, gameCode: String(gameCode) },
          });
        }),
      ),
    );
  }
}
