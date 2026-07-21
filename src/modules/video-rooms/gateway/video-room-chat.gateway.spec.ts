import { VideoRoomChatGateway } from './video-room-chat.gateway';

function socket(userId = 'u1') {
  return { data: { user: { id: userId, roles: [] } } } as never;
}

describe('VideoRoomChatGateway', () => {
  let typing: { start: jest.Mock; stop: jest.Mock };
  let receipts: { markDelivered: jest.Mock; markRead: jest.Mock };
  let gateway: VideoRoomChatGateway;

  beforeEach(() => {
    typing = { start: jest.fn(), stop: jest.fn() };
    receipts = { markDelivered: jest.fn(), markRead: jest.fn() };
    gateway = new VideoRoomChatGateway(typing as never, receipts as never);
  });

  it('starts typing for the authenticated socket user', async () => {
    await gateway.typingStart(socket(), { roomId: 'r1' });
    expect(typing.start).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1');
  });

  it('stops typing', async () => {
    await gateway.typingStop(socket(), { roomId: 'r1' });
    expect(typing.stop).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1');
  });

  it('records a delivered receipt', async () => {
    await gateway.messageDelivered(socket(), { roomId: 'r1', messageId: 'm1' });
    expect(receipts.markDelivered).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', 'm1');
  });

  it('records a read receipt', async () => {
    await gateway.messageRead(socket(), { roomId: 'r1', messageId: 'm1' });
    expect(receipts.markRead).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', 'm1');
  });

  it('ignores an unauthenticated socket instead of throwing', async () => {
    // A gateway handler that throws can tear the connection down. Ephemeral
    // signals are not worth a disconnect.
    await expect(
      gateway.typingStart({ data: {} } as never, { roomId: 'r1' }),
    ).resolves.toBeUndefined();
    expect(typing.start).not.toHaveBeenCalled();
  });

  it('swallows a service rejection — a bad typing ping must not kill the socket', async () => {
    typing.start.mockRejectedValue(new Error('not a member'));
    await expect(gateway.typingStart(socket(), { roomId: 'r1' })).resolves.toBeUndefined();
  });

  it('ignores a payload with no roomId', async () => {
    await gateway.typingStart(socket(), {} as never);
    expect(typing.start).not.toHaveBeenCalled();
  });
});
