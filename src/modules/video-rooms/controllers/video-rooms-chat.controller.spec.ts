import { VideoRoomsChatController } from './video-rooms-chat.controller';

const USER = { id: 'u1', roles: [] } as never;
const META = { requestId: 'req-1', ip: '10.0.0.1', userAgent: 'jest' } as never;

describe('VideoRoomsChatController', () => {
  let chat: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let pins: Record<string, jest.Mock>;
  let announcements: Record<string, jest.Mock>;
  let receipts: Record<string, jest.Mock>;
  let settings: Record<string, jest.Mock>;
  let controller: VideoRoomsChatController;

  beforeEach(() => {
    chat = { send: jest.fn(), edit: jest.fn(), remove: jest.fn(), recall: jest.fn() };
    query = { history: jest.fn(), search: jest.fn(), unreadCount: jest.fn() };
    pins = { pin: jest.fn(), unpin: jest.fn(), listPinned: jest.fn() };
    announcements = { create: jest.fn(), update: jest.fn(), remove: jest.fn(), list: jest.fn() };
    receipts = { readers: jest.fn() };
    settings = { update: jest.fn() };
    controller = new VideoRoomsChatController(
      chat as never,
      query as never,
      pins as never,
      announcements as never,
      receipts as never,
      settings as never,
    );
  });

  it('threads the request audit context into send', async () => {
    await controller.send(USER, 'r1', { content: 'hi' } as never, META);

    expect(chat.send).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      'r1',
      { content: 'hi' },
      { ip: '10.0.0.1', requestId: 'req-1', userAgent: 'jest' },
    );
  });

  it('passes the message id through on edit', async () => {
    await controller.edit(USER, 'r1', 'm1', { content: 'x' } as never, META);
    expect(chat.edit).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      'r1',
      'm1',
      'x',
      expect.any(Object),
    );
  });

  it('routes recall separately from delete', async () => {
    await controller.recall(USER, 'r1', 'm1', META);
    expect(chat.recall).toHaveBeenCalled();
    expect(chat.remove).not.toHaveBeenCalled();
  });

  it('takes the unpin target from the path, not the body', async () => {
    await controller.unpin(USER, 'r1', 'm1', META);
    expect(pins.unpin).toHaveBeenCalledWith(
      { id: 'u1', roles: [] },
      'r1',
      'm1',
      expect.any(Object),
    );
  });

  it('delegates history and search to the query service', async () => {
    await controller.history(USER, 'r1', { page: 1, limit: 20, skip: 0 } as never);
    await controller.search(USER, 'r1', { page: 1, limit: 20, skip: 0, q: 'x' } as never);
    expect(query.history).toHaveBeenCalled();
    expect(query.search).toHaveBeenCalled();
  });

  it('delegates PATCH .../chat/settings to the chat settings service (VR-9.1a)', async () => {
    await controller.updateSettings(USER, 'r1', { chatMode: 'PARTICIPANTS_ONLY' } as never, META);

    expect(settings.update).toHaveBeenCalledWith({ id: 'u1', roles: [] }, 'r1', {
      chatMode: 'PARTICIPANTS_ONLY',
    });
  });
});
