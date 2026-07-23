import { GiftRefundedEvent, type GiftRefundedPayload } from './gift.events';

describe('GiftRefundedPayload', () => {
  it('accepts an optional receiverId and preserves it on the event', () => {
    const payload: GiftRefundedPayload = {
      transactionId: 't1',
      senderId: 's1',
      receiverId: 'r1',
      roomId: 'room1',
      giftId: 'g1',
      giftName: 'Rose',
      totalRefundAmount: 10,
      createdAt: new Date().toISOString(),
    };
    const event = new GiftRefundedEvent(payload);
    expect(event.payload.receiverId).toBe('r1');
  });

  it('remains valid without receiverId (backward compatible)', () => {
    const payload: GiftRefundedPayload = {
      transactionId: 't1',
      senderId: 's1',
      roomId: 'room1',
      giftId: 'g1',
      giftName: 'Rose',
      totalRefundAmount: 10,
      createdAt: new Date().toISOString(),
    };
    expect(new GiftRefundedEvent(payload).payload.receiverId).toBeUndefined();
  });
});
