import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatPinService } from './video-room-chat-pin.service';

const ACTOR = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const MSG = { id: 'm1', roomId: 'r1', deletedAt: null, recalledAt: null };

describe('VideoRoomChatPinService', () => {
  let permissions: { assertPermission: jest.Mock };
  let rooms: { findById: jest.Mock };
  let repo: Record<string, jest.Mock>;
  let cache: { setPins: jest.Mock };
  let locks: { withLock: jest.Mock };
  let bus: { publish: jest.Mock };
  let config: { get: jest.Mock };
  let service: VideoRoomChatPinService;

  beforeEach(() => {
    permissions = { assertPermission: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue(ROOM) };
    repo = {
      findMessage: jest.fn().mockResolvedValue(MSG),
      findActivePin: jest.fn().mockResolvedValue(null),
      countActivePins: jest.fn().mockResolvedValue(0),
      createPin: jest.fn().mockResolvedValue({ id: 'p1' }),
      deactivatePin: jest.fn(),
      listActivePins: jest.fn().mockResolvedValue([]),
      listMessagesByIds: jest.fn().mockResolvedValue([]),
    };
    cache = { setPins: jest.fn() };
    // withLock must actually run the callback so the guarded logic is tested.
    locks = { withLock: jest.fn((_key, fn) => fn()) };
    bus = { publish: jest.fn() };
    config = { get: jest.fn().mockReturnValue({ maxPins: 3 }) };
    service = new VideoRoomChatPinService(
      permissions as never,
      rooms as never,
      repo as never,
      cache as never,
      locks as never,
      bus as never,
      config as never,
    );
  });

  it('requires PIN_MESSAGES before touching anything', async () => {
    permissions.assertPermission.mockRejectedValue(new Error('denied'));
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toThrow('denied');
    expect(repo.createPin).not.toHaveBeenCalled();
  });

  it('pins under a per-room lock so the cap cannot be raced', async () => {
    await service.pin(ACTOR as never, 'r1', 'm1');

    expect(locks.withLock).toHaveBeenCalledWith('video-room:chat:pin:{r1}', expect.any(Function));
    expect(repo.createPin).toHaveBeenCalledWith({
      roomId: 'r1',
      messageId: 'm1',
      pinnedBy: 'u1',
    });
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_pinned');
  });

  it('refuses to pin a message from another room', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, roomId: 'other' });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('refuses to pin a deleted message', async () => {
    repo.findMessage.mockResolvedValue({ ...MSG, deletedAt: new Date() });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('refuses a duplicate pin', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.ALREADY_PINNED,
    });
  });

  it('enforces the pin cap', async () => {
    repo.countActivePins.mockResolvedValue(3);
    await expect(service.pin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PIN_LIMIT_REACHED,
    });
  });

  it('refreshes the Redis pin set after pinning', async () => {
    repo.listActivePins.mockResolvedValue([{ messageId: 'm1' }, { messageId: 'm2' }]);
    await service.pin(ACTOR as never, 'r1', 'm1');
    expect(cache.setPins).toHaveBeenCalledWith('r1', ['m1', 'm2']);
  });

  it('unpins an active pin', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });
    await service.unpin(ACTOR as never, 'r1', 'm1');

    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_unpinned');
  });

  it('404s when unpinning something that is not pinned', async () => {
    await expect(service.unpin(ACTOR as never, 'r1', 'm1')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PIN_NOT_FOUND,
    });
  });

  it('lists pinned messages in one batched query, not N+1', async () => {
    repo.listActivePins.mockResolvedValue([{ messageId: 'm1' }, { messageId: 'm2' }]);
    repo.listMessagesByIds.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);

    const result = await service.listPinned('r1');

    expect(repo.listMessagesByIds).toHaveBeenCalledWith(['m1', 'm2']);
    expect(repo.findMessage).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });
});
