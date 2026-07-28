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
    // The sender is checked as a member once as the sender, once as the
    // recipient — no branch treats the two ids being equal as special.
    expect(rooms.assertMember).toHaveBeenCalledWith('room-1', 'sender-1');
    expect(rooms.isMember).toHaveBeenCalledWith('room-1', 'sender-1');
  });

  it('rejects a self-gift from outside the room like any other send', async () => {
    // Room membership still governs: leaving the room revokes self-gifting too.
    rooms.isMember.mockResolvedValue(false);
    const selfReq = { ...REQ, receiverIds: ['sender-1'] };

    await expect(handler.validate(selfReq as never)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
    });
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

  it('rejects a receiver who is not in the room', async () => {
    rooms.isMember.mockResolvedValue(false);
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

  it('BC-4: credits the host 10% of the accepted amount', async () => {
    await handler.onSend(TX, CTX as never);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-id',
        amount: 10,
        idempotencyKey: 'gift-host-reward:idem-1',
        referenceId: 'txn-1',
      }),
      TX,
    );
  });

  it('BC-4: publishes the host reward event', async () => {
    const effects = await handler.onSend(TX, CTX as never);
    const reward = effects.events.find((e) => e.name === 'treasure.receiver_reward');
    expect(reward).toBeDefined();
    expect((reward as { payload: Record<string, unknown> }).payload).toMatchObject({
      hostId: 'owner-id',
      rewardAmount: 10,
      boxId: 'box-1',
      level: 2,
    });
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

    it('credits 10% bonus when gift value > 1000 and receiver is active PK participant', async () => {
      const activeBattle = { id: 'battle-123' };
      const participant = { id: 'part-1', userId: 'receiver-1' };
      const tx = {
        pkBattle: { findFirst: jest.fn().mockResolvedValue(activeBattle) },
        pkParticipant: { findUnique: jest.fn().mockResolvedValue(participant) },
      } as any;
      const ctx = { ...CTX, totalCoinValue: 5000 };

      const effects = await handler.onSend(tx, ctx as never);

      expect(tx.pkBattle.findFirst).toHaveBeenCalledWith({
        where: { roomId: 'room-1', status: 'ACTIVE' },
      });
      expect(tx.pkParticipant.findUnique).toHaveBeenCalledWith({
        where: { battleId_userId: { battleId: 'battle-123', userId: 'receiver-1' } },
      });
      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'receiver-1',
          currency: 'GOLD',
          amount: 500,
          reason: 'PK_BATTLE_RECEIVER_BONUS',
          metadata: expect.objectContaining({
            senderId: 'sender-1',
            receiverId: 'receiver-1',
            roomId: 'room-1',
            pkBattleId: 'battle-123',
            originalGiftValue: 5000,
            bonusPercentage: 10,
            bonusCoins: 500,
          }),
        }),
        tx,
      );
      expect(effects.events.map((e) => e.name)).toContain('audio_room.pk_receiver_bonus');
    });

    it('rounds bonus down using integer coin policy (e.g., 1001 coins -> 100 bonus)', async () => {
      const activeBattle = { id: 'battle-123' };
      const participant = { id: 'part-1', userId: 'receiver-1' };
      const tx = {
        pkBattle: { findFirst: jest.fn().mockResolvedValue(activeBattle) },
        pkParticipant: { findUnique: jest.fn().mockResolvedValue(participant) },
      } as any;
      const ctx = { ...CTX, totalCoinValue: 1001 };

      await handler.onSend(tx, ctx as never);

      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'receiver-1',
          amount: 100,
          reason: 'PK_BATTLE_RECEIVER_BONUS',
        }),
        tx,
      );
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
