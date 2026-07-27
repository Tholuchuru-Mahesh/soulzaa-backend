import { GiftContextType } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import type { IEventBus } from 'src/common/events';
import { GIFT_EVENTS } from 'src/modules/gifts/events/gift.events';
import type { ExpService } from '../services/exp.service';
import { ExpActivityListener } from './exp-activity.listener';

const SENDER = 'sender-1';
const RECEIVER = 'receiver-1';
const ROOM = 'room-1';

const giftPayload = (overrides: Record<string, unknown> = {}) => ({
  transactionId: 'gtxn-1',
  senderId: SENDER,
  receiverId: RECEIVER,
  contextType: GiftContextType.AUDIO_ROOM,
  contextId: ROOM,
  senderExp: 100,
  receiverExp: 50,
  ...overrides,
});

describe('ExpActivityListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let exp: { award: jest.Mock; awardRoom: jest.Mock };
  let listener: ExpActivityListener;
  let onGift: (e: { payload: ReturnType<typeof giftPayload> }) => void;

  /**
   * The bus subscription is `(e) => void this.onGift(e)` — fire-and-forget, so
   * the handler's awaits resolve after the caller returns. Flushing the
   * microtask queue makes the assertions deterministic instead of racing it.
   */
  const fire = async (payload: ReturnType<typeof giftPayload>): Promise<void> => {
    onGift({ payload });
    await new Promise((resolve) => setImmediate(resolve));
  };

  const awardedTo = (userId: string, source: ExpSource) =>
    exp.award.mock.calls.filter(
      ([arg]: [{ userId: string; source: ExpSource }]) =>
        arg.userId === userId && arg.source === source,
    );

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    exp = {
      award: jest.fn().mockResolvedValue(undefined),
      awardRoom: jest.fn().mockResolvedValue(undefined),
    };

    listener = new ExpActivityListener(bus as unknown as IEventBus, exp as unknown as ExpService);
    listener.onModuleInit();

    const sub = bus.subscribe.mock.calls.find(([evt]) => evt === GIFT_EVENTS.SENT);
    onGift = sub![1];
  });

  it('awards the sender and the receiver separately for a normal gift', async () => {
    await fire(giftPayload());

    expect(awardedTo(SENDER, ExpSource.GIFT_SENT)).toHaveLength(1);
    expect(awardedTo(RECEIVER, ExpSource.GIFT_RECEIVED)).toHaveLength(1);
    expect(exp.award).toHaveBeenCalledTimes(2);
  });

  // Self-gifting is supported, but it must not be the cheapest route to a level.
  // Awarding both legs to one user would make a self-gift worth
  // (senderRate + receiverRate) per coin while gifting anyone else pays the
  // sender rate alone — turning EXP progression into a self-dealing loop.
  it('awards a self-gift the sender leg ONLY — no double EXP', async () => {
    await fire(giftPayload({ receiverId: SENDER }));

    expect(awardedTo(SENDER, ExpSource.GIFT_SENT)).toHaveLength(1);
    expect(awardedTo(SENDER, ExpSource.GIFT_RECEIVED)).toHaveLength(0);
    expect(exp.award).toHaveBeenCalledTimes(1);
  });

  it('pays a self-gift exactly what gifting someone else pays the sender', async () => {
    await fire(giftPayload({ receiverId: SENDER }));
    const selfTotal = exp.award.mock.calls.reduce(
      (sum: number, [arg]: [{ amount: number }]) => sum + arg.amount,
      0,
    );

    exp.award.mockClear();
    await fire(giftPayload({ transactionId: 'gtxn-2' }));
    const otherSenderLeg = awardedTo(SENDER, ExpSource.GIFT_SENT)[0][0].amount;

    expect(selfTotal).toBe(otherSenderLeg);
  });

  it('still credits room EXP for a self-gift — the room did receive the gift', async () => {
    await fire(giftPayload({ receiverId: SENDER }));

    expect(exp.awardRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM, amount: 100, source: ExpSource.GIFT_SENT }),
    );
  });

  it('swallows an EXP failure so the gift itself is never affected', async () => {
    exp.award.mockRejectedValue(new Error('exp down'));
    await expect(fire(giftPayload())).resolves.toBeUndefined();
    expect(exp.award).toHaveBeenCalled();
  });
});
