import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendVideoRoomGiftDto, VideoRoomGiftTarget } from './send-video-room-gift.dto';

const GIFT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const USER2 = '33333333-3333-4333-8333-333333333333';

const build = (overrides: Record<string, unknown>) =>
  validate(plainToInstance(SendVideoRoomGiftDto, { giftId: GIFT, quantity: 1, ...overrides }));

const fields = async (overrides: Record<string, unknown>) =>
  (await build(overrides)).map((e) => e.property);

describe('SendVideoRoomGiftDto', () => {
  it('accepts a SINGLE send with a receiverId', async () => {
    expect(await build({ target: VideoRoomGiftTarget.SINGLE, receiverId: USER })).toHaveLength(0);
  });

  it('rejects SINGLE without a receiverId', async () => {
    expect(await fields({ target: VideoRoomGiftTarget.SINGLE })).toContain('receiverId');
  });

  it('accepts MULTI with a receiverIds list', async () => {
    expect(
      await build({ target: VideoRoomGiftTarget.MULTI, receiverIds: [USER, USER2] }),
    ).toHaveLength(0);
  });

  it('rejects MULTI with an empty receiverIds array', async () => {
    expect(await fields({ target: VideoRoomGiftTarget.MULTI, receiverIds: [] })).toContain(
      'receiverIds',
    );
  });

  it('rejects MULTI with a non-uuid entry', async () => {
    expect(
      await fields({ target: VideoRoomGiftTarget.MULTI, receiverIds: [USER, 'nope'] }),
    ).toContain('receiverIds');
  });

  it('accepts SEAT_ALL without any recipient fields', async () => {
    expect(await build({ target: VideoRoomGiftTarget.SEAT_ALL })).toHaveLength(0);
  });

  it('rejects an unknown target', async () => {
    expect(await fields({ target: 'EVERYONE_EVERYWHERE' })).toContain('target');
  });

  it('rejects a non-uuid giftId', async () => {
    expect(await fields({ giftId: 'nope', target: VideoRoomGiftTarget.SEAT_ALL })).toContain(
      'giftId',
    );
  });

  it.each([0, -1, 1000])('rejects quantity %p', async (quantity) => {
    expect(await fields({ target: VideoRoomGiftTarget.SEAT_ALL, quantity })).toContain('quantity');
  });

  it('rejects an over-long idempotency key', async () => {
    expect(
      await fields({ target: VideoRoomGiftTarget.SEAT_ALL, idempotencyKey: 'x'.repeat(129) }),
    ).toContain('idempotencyKey');
  });
});
