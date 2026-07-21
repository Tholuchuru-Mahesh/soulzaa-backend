import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatReceiptService } from './video-room-chat-receipt.service';

const ACTOR = { id: 'u1', roles: [] };
const AT = new Date('2026-07-21T10:00:00Z');
const MSG = { id: 'm5', roomId: 'r1', createdAt: AT };

describe('VideoRoomChatReceiptService', () => {
  let repo: Record<string, jest.Mock>;
  let policy: { assertActiveMember: jest.Mock };
  let redis: { set: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomChatReceiptService;

  beforeEach(() => {
    repo = {
      findMessage: jest.fn().mockResolvedValue(MSG),
      findCursor: jest.fn().mockResolvedValue(null),
      upsertCursor: jest.fn(),
      listReaders: jest.fn().mockResolvedValue([{ userId: 'u2' }, { userId: 'u3' }]),
    };
    policy = { assertActiveMember: jest.fn() };
    redis = { set: jest.fn().mockResolvedValue('OK') };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ receiptThrottleMs: 2000 }) };
    service = new VideoRoomChatReceiptService(
      repo as never,
      policy as never,
      redis as never,
      bus as never,
      config as never,
    );
  });

  it('advances the read cursor and publishes', async () => {
    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      readMessageId: 'm5',
      readAt: AT,
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_read');
  });

  it('ignores a cursor that would move BACKWARDS', async () => {
    // Out-of-order receipts are normal on a lossy mobile connection. A
    // high-water mark that can retreat is not a high-water mark.
    repo.findCursor.mockResolvedValue({ lastReadAt: new Date('2026-07-21T11:00:00Z') });

    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('advances when the new mark is strictly newer', async () => {
    repo.findCursor.mockResolvedValue({ lastReadAt: new Date('2026-07-21T09:00:00Z') });
    await service.markRead(ACTOR as never, 'r1', 'm5');
    expect(repo.upsertCursor).toHaveBeenCalled();
  });

  it('throttles repeated receipts inside the window', async () => {
    // SET NX returns null ⇒ a receipt was already recorded very recently.
    redis.set.mockResolvedValue(null);

    await service.markRead(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).not.toHaveBeenCalled();
  });

  it('advances the delivered cursor independently of read', async () => {
    await service.markDelivered(ACTOR as never, 'r1', 'm5');

    expect(repo.upsertCursor).toHaveBeenCalledWith({
      roomId: 'r1',
      userId: 'u1',
      deliveredMessageId: 'm5',
      deliveredAt: AT,
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_delivered');
  });

  it('404s on a message from another room', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, roomId: 'other' });
    await expect(service.markRead(ACTOR as never, 'r1', 'm5')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('derives the reader list from cursors at or past the message', async () => {
    const result = await service.readers(ACTOR as never, 'r1', 'm5');

    expect(repo.listReaders).toHaveBeenCalledWith('r1', AT);
    expect(result).toEqual({ userIds: ['u2', 'u3'] });
  });
});
