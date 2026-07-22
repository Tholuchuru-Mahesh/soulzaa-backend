import { VideoRoomGiftTarget } from '../dto/send-video-room-gift.dto';
import { VideoRoomsGiftsController } from './video-rooms-gifts.controller';

const USER = { id: 'sender-1', roles: ['USER'] } as never;
const ROOM = 'r1';
const ACTOR = { id: 'sender-1', roles: ['USER'] };

describe('VideoRoomsGiftsController', () => {
  let gifts: { send: jest.Mock };
  let query: Record<string, jest.Mock>;
  let reversals: Record<string, jest.Mock>;
  let controller: VideoRoomsGiftsController;

  beforeEach(() => {
    gifts = { send: jest.fn().mockResolvedValue({ batchId: 'b1' }) };
    query = {
      history: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      recent: jest.fn().mockResolvedValue([]),
      combos: jest.fn().mockResolvedValue([]),
      statisticsFor: jest.fn().mockResolvedValue({ totalGifts: 5 }),
    };
    reversals = {
      reverseTransaction: jest.fn().mockResolvedValue({ transactionId: 't1' }),
      reverseBatch: jest.fn().mockResolvedValue([{ transactionId: 't1' }]),
    };
    controller = new VideoRoomsGiftsController(gifts as never, query as never, reversals as never);
  });

  it('POST /send passes the actor, room and body through', async () => {
    const dto = { giftId: 'g1', target: VideoRoomGiftTarget.SINGLE, quantity: 1 } as never;
    await expect(controller.send(USER, ROOM, dto)).resolves.toEqual({ batchId: 'b1' });
    expect(gifts.send).toHaveBeenCalledWith(ACTOR, ROOM, dto);
  });

  it('GET /history passes the query through', async () => {
    const q = { page: 1, limit: 20, skip: 0, senderId: 's9' } as never;
    await controller.history(ROOM, q);
    expect(query.history).toHaveBeenCalledWith(ROOM, q);
  });

  it('GET /recent returns the live feed', async () => {
    query.recent.mockResolvedValue([{ transactionId: 't1' }]);
    await expect(controller.recent(ROOM)).resolves.toEqual([{ transactionId: 't1' }]);
    expect(query.recent).toHaveBeenCalledWith(ROOM);
  });

  it('GET /combo returns active combos', async () => {
    query.combos.mockResolvedValue([{ senderId: 's1', tier: 3 }]);
    await expect(controller.combos(ROOM)).resolves.toHaveLength(1);
    expect(query.combos).toHaveBeenCalledWith(ROOM);
  });

  /** Authorization lives in the service, per module convention — assert delegation. */
  it('GET /statistics delegates the permission decision to the service', async () => {
    await expect(controller.statistics(USER, ROOM)).resolves.toEqual({ totalGifts: 5 });
    expect(query.statisticsFor).toHaveBeenCalledWith(ROOM, ACTOR);
  });

  it('POST /:transactionId/reverse delegates to the reversal service', async () => {
    await controller.reverse(USER, ROOM, 't1', { reason: 'chargeback' } as never);
    expect(reversals.reverseTransaction).toHaveBeenCalledWith(ROOM, 't1', 'sender-1', 'chargeback');
  });

  it('POST /batches/:batchId/reverse reverses every leg', async () => {
    await controller.reverseBatch(USER, ROOM, 'b1', { reason: 'fraud' } as never);
    expect(reversals.reverseBatch).toHaveBeenCalledWith(ROOM, 'b1', 'sender-1', 'fraud');
  });

  it('never makes an authorization decision itself', () => {
    const source = VideoRoomsGiftsController.prototype.constructor.toString();
    expect(source).not.toContain('hasPermission');
    expect(source).not.toContain('VIEW_ANALYTICS');
  });
});
