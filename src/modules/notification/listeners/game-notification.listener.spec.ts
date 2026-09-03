import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { GAME_EVENTS } from 'src/modules/games/events/game.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { GameNotificationListener } from './game-notification.listener';

const WINNER = 'winner-1';
const LOSER = 'loser-1';

type Handler = (e: { payload: Record<string, unknown> }) => Promise<void>;

describe('GameNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = {
      once: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };

    const listener = new GameNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();

    handlers = new Map<string, Handler>(bus.subscribe.mock.calls as [string, Handler][]);
  });

  const settle = (overrides: Record<string, unknown> = {}) =>
    handlers.get(GAME_EVENTS.SETTLED)!({
      payload: {
        sessionId: 'sess-1',
        gameCode: 'LUDO',
        winners: [WINNER],
        participants: [WINNER, LOSER],
        payouts: [{ userId: WINNER, amount: 200 }],
        ...overrides,
      },
    });

  it('does not dispatch in-app or push notifications when game settles', async () => {
    await settle();

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does not dispatch in-app or push notifications when a match is found', async () => {
    await handlers.get(GAME_EVENTS.MATCH_FOUND)!({
      payload: { matchId: 'm-1', gameCode: 'LUDO', stake: 100, players: [WINNER, LOSER] },
    });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  // In-session churn is socket traffic — the player is already looking at the
  // board. A notification per lobby join or per turn would be pure noise.
  it('does not subscribe to lobby churn, turn, or move events', () => {
    const subscribed = [...handlers.keys()];

    expect(subscribed).not.toContain(GAME_EVENTS.LOBBY_JOINED);
    expect(subscribed).not.toContain(GAME_EVENTS.LOBBY_LEFT);
    expect(subscribed).not.toContain(GAME_EVENTS.LOBBY_MEMBER_READY);
    expect(subscribed).not.toContain(GAME_EVENTS.MOVE);
    expect(subscribed).not.toContain(GAME_EVENTS.MATCH_READY_PROGRESS);
  });

  it('handles a settlement with no winners without crashing', async () => {
    await settle({ winners: [], payouts: [] });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
