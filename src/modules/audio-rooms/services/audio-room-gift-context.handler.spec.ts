import { AUDIO_ROOM_PK_EVENTS } from '../events/audio-room-pk.events';
import { GiftContextType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { AudioRoomGiftContextHandler } from './audio-room-gift-context.handler';

const REQ = {
  contextType: GiftContextType.AUDIO_ROOM,
  contextId: 'room-1',
  senderId: 'sender-1',
  receiverIds: ['receiver-1'],
  gift: { id: 'gift-1', name: 'Rose', coinValue: 100 },
  quantity: 1,
};

describe('AudioRoomGiftContextHandler', () => {
  let rooms: Record<string, jest.Mock>;
  let users: { findById: jest.Mock };
  let registry: { register: jest.Mock };
  let handler: AudioRoomGiftContextHandler;

  beforeEach(() => {
    rooms = {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(true),
      hasEverBeenMember: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue('owner-id'),
    };
    users = { findById: jest.fn().mockResolvedValue({ id: 'receiver-1' }) };
    registry = { register: jest.fn() };
    handler = new AudioRoomGiftContextHandler(
      rooms as never,
      users as never,
      registry as never,
      { credit: jest.fn() } as never,
      { processTreasureContribution: jest.fn() } as never,
    );
  });

  it('registers itself on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('declares AUDIO_ROOM with maxReceivers = 1', () => {
    expect(handler.contextType).toBe(GiftContextType.AUDIO_ROOM);
    expect(handler.maxReceivers).toBe(1);
  });

  it('accepts a valid single-receiver send', async () => {
    await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    expect(rooms.assertMember).toHaveBeenCalledWith('room-1', 'sender-1');
  });

  it('accepts a self-gift: the sender may name themselves as the recipient', async () => {
    users.findById.mockResolvedValue({ id: 'sender-1' });
    const selfReq = { ...REQ, receiverIds: ['sender-1'] };

    await expect(handler.validate(selfReq as never)).resolves.toBeUndefined();
    expect(rooms.assertMember).toHaveBeenCalledWith('room-1', 'sender-1');
    expect(rooms.hasEverBeenMember).toHaveBeenCalledWith('room-1', 'sender-1');
  });

  it('accepts a gift sent to owner/receiver who has left the room as long as room is live', async () => {
    rooms.isMember.mockResolvedValue(false); // receiver left room
    rooms.hasEverBeenMember.mockResolvedValue(true);
    users.findById.mockResolvedValue({ id: 'owner-id' });

    const ownerReq = { ...REQ, receiverIds: ['owner-id'] };
    await expect(handler.validate(ownerReq as never)).resolves.toBeUndefined();
  });

  it('rejects a self-gift from outside the room when sender is not in room', async () => {
    rooms.assertMember.mockRejectedValue(new Error('NOT_ROOM_MEMBER'));
    const selfReq = { ...REQ, receiverIds: ['sender-1'] };

    await expect(handler.validate(selfReq as never)).rejects.toThrow('NOT_ROOM_MEMBER');
  });

  it('rejects a self-gift into a dead room like any other send', async () => {
    rooms.isRoomLive.mockResolvedValue(false);
    const selfReq = { ...REQ, receiverIds: ['sender-1'] };

    await expect(handler.validate(selfReq as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });

  it('rejects a send when the room is not live', async () => {
    rooms.isRoomLive.mockResolvedValue(false);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });

  it('rejects a receiver who has never been a member of the room', async () => {
    rooms.hasEverBeenMember.mockResolvedValue(false);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
  });

  it('rejects a receiver who does not exist', async () => {
    users.findById.mockResolvedValue(null);
    await expect(handler.validate(REQ as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
  });

  it('propagates the membership failure for a non-member sender', async () => {
    rooms.assertMember.mockRejectedValue(new Error('NOT_ROOM_MEMBER'));
    await expect(handler.validate(REQ as never)).rejects.toThrow('NOT_ROOM_MEMBER');
  });

  it('rejects more than one receiver', async () => {
    await expect(
      handler.validate({ ...REQ, receiverIds: ['a', 'b'] } as never),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
  });

  it('checks the room is live before touching membership (cheap gate first)', async () => {
    rooms.isRoomLive.mockResolvedValue(false);
    await expect(handler.validate(REQ as never)).rejects.toBeDefined();
    expect(rooms.assertMember).not.toHaveBeenCalled();
  });

  it('requires the treasure-room lock for the send transaction', () => {
    expect(handler.contextLockKeys(REQ as never)).toEqual(['treasure:room:{room-1}']);
  });
});

describe('AudioRoomGiftContextHandler.onSend (treasure + host reward + refund)', () => {
  const CTX = {
    ...REQ,
    transactionId: 'txn-1',
    batchId: 'batch-1',
    idempotencyKey: 'idem-1',
    totalCoinValue: 100,
  };

  let rooms: Record<string, jest.Mock>;
  let wallet: Record<string, jest.Mock>;
  let treasure: Record<string, jest.Mock>;
  let handler: AudioRoomGiftContextHandler;
  const TX = {} as never;

  beforeEach(() => {
    rooms = {
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
      isMember: jest.fn().mockResolvedValue(true),
      getOwnerId: jest.fn().mockResolvedValue('owner-id'),
    };
    wallet = {
      credit: jest.fn().mockResolvedValue({ transactionId: 'w-credit', duplicate: false }),
    };
    treasure = {
      processTreasureContribution: jest.fn().mockResolvedValue({
        acceptedAmount: 100,
        refundAmount: 0,
        events: [],
        boxId: 'box-1',
        level: 2,
        postCommit: undefined,
      }),
    };
    handler = new AudioRoomGiftContextHandler(
      rooms as never,
      { findById: jest.fn() } as never,
      { register: jest.fn() } as never,
      wallet as never,
      treasure as never,
    );
  });

  it('BC-3: routes the total through the treasure box with the txn correlation id', async () => {
    const effects = await handler.onSend(TX, CTX as never);
    expect(treasure.processTreasureContribution).toHaveBeenCalledWith(
      TX,
      'room-1',
      'sender-1',
      'receiver-1',
      100,
      'txn-1',
    );
    expect(effects.acceptedAmount).toBe(100);
  });

  it('BC-4: does not credit extra host reward when HOST_REWARD_RATE is 0', async () => {
    await handler.onSend(TX, CTX as never);
    expect(wallet.credit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gift-host-reward:idem-1',
      }),
      TX,
    );
  });

  it('BC-4: skips the host reward when the accepted amount rounds to zero', async () => {
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 5,
      refundAmount: 0,
      events: [],
      boxId: 'box-1',
      level: 1,
    });
    await handler.onSend(TX, CTX as never);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('BC-5: refunds the excess to the sender and emits gift.refunded', async () => {
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 60,
      refundAmount: 40,
      events: [],
      boxId: 'box-1',
      level: 2,
    });
    const effects = await handler.onSend(TX, CTX as never);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'sender-1',
        amount: 40,
        idempotencyKey: 'gift-refund:idem-1',
      }),
      TX,
    );
    expect(effects.events.map((e) => e.name)).toContain('gift.refunded');
    expect(effects.refundAmount).toBe(40);
  });

  it('forwards the treasure module postCommit callback', async () => {
    const postCommit = jest.fn();
    treasure.processTreasureContribution.mockResolvedValue({
      acceptedAmount: 100,
      refundAmount: 0,
      events: [],
      postCommit,
    });
    const effects = await handler.onSend(TX, CTX as never);
    expect(effects.postCommit).toBe(postCommit);
  });

  it('performs no host credit when the room has no owner', async () => {
    rooms.getOwnerId.mockResolvedValue(null);
    await handler.onSend(TX, CTX as never);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('BC-4: does not credit host reward even when the owner IS the receiver when HOST_REWARD_RATE is 0', async () => {
    rooms.getOwnerId.mockResolvedValue('receiver-1');
    await handler.onSend(TX, CTX as never);
    expect(wallet.credit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'gift-host-reward:idem-1',
      }),
      TX,
    );
  });

  describe('High-Value Gift PK Battle Bonus', () => {
    it('does NOT credit bonus if gift value <= 1000', async () => {
      const tx = {
        pkBattle: { findFirst: jest.fn() },
        pkParticipant: { findUnique: jest.fn() },
      } as any;
      const ctx = { ...CTX, totalCoinValue: 1000 };
      await handler.onSend(tx, ctx as never);

      expect(tx.pkBattle.findFirst).not.toHaveBeenCalled();
    });

    it('credits no receiver bonus, however large the gift or however active the battle', async () => {
      // Replaces two tests that asserted a 10% PK_BATTLE_RECEIVER_BONUS on top
      // of the standard cashback. That double-credit was the bug: the receiver's
      // 10% is settled once by GiftService, and stacking a second slice here
      // paid 20% on every PK gift over the threshold.
      const tx = {
        pkBattle: { findFirst: jest.fn().mockResolvedValue({ id: 'battle-123' }) },
        pkParticipant: {
          findUnique: jest.fn().mockResolvedValue({ id: 'part-1', userId: 'receiver-1' }),
        },
      } as any;

      for (const totalCoinValue of [1001, 5000, 10000]) {
        wallet.credit.mockClear();
        await handler.onSend(tx, { ...CTX, totalCoinValue } as never);

        expect(wallet.credit).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'PK_BATTLE_RECEIVER_BONUS' }),
          tx,
        );
      }
    });

    it('does NOT credit bonus if receiver is not a PK participant', async () => {
      const activeBattle = { id: 'battle-123' };
      const tx = {
        pkBattle: { findFirst: jest.fn().mockResolvedValue(activeBattle) },
        pkParticipant: { findUnique: jest.fn().mockResolvedValue(null) },
      } as any;
      const ctx = { ...CTX, totalCoinValue: 5000 };

      await handler.onSend(tx, ctx as never);

      expect(wallet.credit).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'PK_BATTLE_RECEIVER_BONUS' }),
        tx,
      );
    });

    it('does NOT credit bonus if no active PK battle in room', async () => {
      const tx = {
        pkBattle: { findFirst: jest.fn().mockResolvedValue(null) },
        pkParticipant: { findUnique: jest.fn() },
      } as any;
      const ctx = { ...CTX, totalCoinValue: 5000 };

      await handler.onSend(tx, ctx as never);

      expect(tx.pkParticipant.findUnique).not.toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'PK_BATTLE_RECEIVER_BONUS' }),
        tx,
      );
    });
  });
});

/**
 * The receiver's cashback is settled once, by `GiftService` (Step 3b), at the
 * configured 10%. This handler must not add a second slice on top.
 *
 * It used to: a `PK_BATTLE_RECEIVER_BONUS` credit of another 10% fired whenever
 * the receiver was a participant in an active battle, so the same gift paid out
 * twice and a 10,000-coin gift landed 2,000 in the wallet instead of 1,000.
 * Earnings and analytics were never affected — only the spendable balance.
 */
describe('AudioRoomGiftContextHandler.onSend during an active PK battle', () => {
  const CTX = {
    ...REQ,
    transactionId: 'txn-pk',
    batchId: 'batch-pk',
    idempotencyKey: 'idem-pk',
    totalCoinValue: 10000,
  };

  let wallet: Record<string, jest.Mock>;
  let handler: AudioRoomGiftContextHandler;
  let tx: Record<string, unknown>;

  beforeEach(() => {
    wallet = {
      credit: jest.fn().mockResolvedValue({ transactionId: 'w-credit', duplicate: false }),
    };
    // An active battle with the receiver as a participant — the exact state the
    // duplicate bonus used to trigger on.
    tx = {
      pkBattle: { findFirst: jest.fn().mockResolvedValue({ id: 'battle-1' }) },
      pkParticipant: {
        findUnique: jest.fn().mockResolvedValue({ battleId: 'battle-1', userId: 'receiver-1' }),
      },
    };
    handler = new AudioRoomGiftContextHandler(
      {
        isRoomLive: jest.fn().mockResolvedValue(true),
        assertMember: jest.fn().mockResolvedValue(undefined),
        isMember: jest.fn().mockResolvedValue(true),
        // No host, so the only credits that can appear are receiver-facing ones.
        getOwnerId: jest.fn().mockResolvedValue(null),
      } as never,
      { findById: jest.fn() } as never,
      { register: jest.fn() } as never,
      wallet as never,
      {
        processTreasureContribution: jest.fn().mockResolvedValue({
          acceptedAmount: 10000,
          refundAmount: 0,
          events: [],
          boxId: 'box-1',
          level: 1,
          postCommit: undefined,
        }),
      } as never,
    );
  });

  it('does not credit the receiver a second cashback slice', async () => {
    await handler.onSend(tx as never, CTX as never);

    const receiverCredits = wallet.credit.mock.calls.filter(
      (call: [{ userId: string }]) => call[0].userId === 'receiver-1',
    );
    expect(receiverCredits).toEqual([]);
  });

  it('emits no PK receiver-bonus event', async () => {
    const effects = await handler.onSend(tx as never, CTX as never);

    // Asserted against the event's real `name` (AUDIO_ROOM_PK_EVENTS.RECEIVER_BONUS),
    // not its class name — matching on the class name passed even while the
    // event was still being emitted, which is a test that proves nothing.
    const names = effects.events.map((e) => (e as { name: string }).name);
    expect(names).not.toContain(AUDIO_ROOM_PK_EVENTS.RECEIVER_BONUS);
  });

  it('still routes the gift through the treasure box', async () => {
    // The bonus is going away; nothing else about a PK-battle send changes.
    const effects = await handler.onSend(tx as never, CTX as never);
    expect(effects.acceptedAmount).toBe(10000);
  });
});
