import {
  VIDEO_ROOM_GIFT_EVENTS,
  VideoRoomGiftAnimationEvent,
  VideoRoomGiftComboEndedEvent,
  VideoRoomGiftDeliveredEvent,
  VideoRoomGiftFailedEvent,
} from './video-room-gift.events';

describe('video-room gift events', () => {
  it('carries the full correlation envelope on a delivery event', () => {
    const event = new VideoRoomGiftDeliveredEvent({
      batchId: 'b1',
      transactionId: 't1',
      roomId: 'r1',
      senderId: 's1',
      receiverId: 'u1',
      giftId: 'g1',
      jobId: 'j1',
      attempt: 1,
    });

    expect(event.name).toBe(VIDEO_ROOM_GIFT_EVENTS.DELIVERED);
    expect(Object.keys(event.payload).sort()).toEqual([
      'attempt',
      'batchId',
      'giftId',
      'jobId',
      'receiverId',
      'roomId',
      'senderId',
      'transactionId',
    ]);
  });

  it('animation is batch-level: arrays, and no singular receiverId', () => {
    const event = new VideoRoomGiftAnimationEvent({
      batchId: 'b1',
      transactionIds: ['t1', 't2'],
      receiverIds: ['u1', 'u2'],
      roomId: 'r1',
      senderId: 's1',
      giftId: 'g1',
      jobId: 'j1',
      attempt: 1,
      giftName: 'Rocket',
      animationUrl: null,
      soundUrl: null,
      comboTier: 1,
      quantity: 1,
      totalCoinValue: 200,
    });

    expect(event.payload).not.toHaveProperty('receiverId');
    expect(event.payload).not.toHaveProperty('transactionId');
    expect(event.payload.receiverIds).toHaveLength(2);
    expect(event.payload.transactionIds).toHaveLength(2);
  });

  it('a failure event explains itself', () => {
    const event = new VideoRoomGiftFailedEvent({
      batchId: 'b1',
      transactionId: 't1',
      roomId: 'r1',
      senderId: 's1',
      receiverId: 'u1',
      giftId: 'g1',
      jobId: 'j1',
      attempt: 5,
      reason: 'socket down',
    });
    expect(event.payload.reason).toBe('socket down');
    expect(event.name).toBe(VIDEO_ROOM_GIFT_EVENTS.FAILED);
  });

  it('combo ended reports the final tier', () => {
    const event = new VideoRoomGiftComboEndedEvent({
      roomId: 'r1',
      senderId: 's1',
      giftId: 'g1',
      finalTier: 7,
    });
    expect(event.name).toBe(VIDEO_ROOM_GIFT_EVENTS.COMBO_ENDED);
    expect(event.payload.finalTier).toBe(7);
  });

  it('namespaces every event name under video_room.gift', () => {
    for (const name of Object.values(VIDEO_ROOM_GIFT_EVENTS)) {
      expect(name.startsWith('video_room.gift.')).toBe(true);
    }
  });

  it('does NOT redeclare gifts-module events (no double-fire)', () => {
    const names: string[] = Object.values(VIDEO_ROOM_GIFT_EVENTS);
    expect(names).not.toContain('gift.sent');
    expect(names).not.toContain('gift.combo');
    expect(names).not.toContain('gift.lucky_win');
    expect(names).not.toContain('gift.refunded');
  });
});
