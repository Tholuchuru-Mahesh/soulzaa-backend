import { GiftContextType, VideoRoomMemberRole, VideoRoomStatus } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { IGiftContextHandler } from 'src/modules/gifts/interfaces/gift-context-handler.interface';
import { VideoRoomGiftContextHandler } from './video-room-gift-context.handler';

const ROOM = 'r1';
const SENDER = 'sender-1';

const REQ = {
  contextType: GiftContextType.VIDEO_ROOM,
  contextId: ROOM,
  senderId: SENDER,
  receiverIds: ['u1'],
  gift: { id: 'g1', name: 'Rocket', coinValue: 100 },
  quantity: 1,
};

const GIFT_CFG = { creatorEarningRatePercent: 30 };
const VR_GIFT_CFG = {
  blockedCountries: '',
  maxReceivers: 9,
  allowRoomAll: 'false',
  allowViewerGiftsDefault: 'true',
  recentFeedSize: 50,
  monitorIntervalSeconds: 15,
  recoveryEnabled: 'false',
};

const member = (overrides: Record<string, unknown> = {}) => ({
  isActive: true,
  role: VideoRoomMemberRole.PARTICIPANT,
  ...overrides,
});

describe('VideoRoomGiftContextHandler', () => {
  let rooms: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let registry: { register: jest.Mock };
  let handler: VideoRoomGiftContextHandler;

  const setGiftConfig = (overrides: Record<string, unknown> = {}) => {
    config.get.mockImplementation((ns: string) =>
      ns === 'gift' ? GIFT_CFG : { ...VR_GIFT_CFG, ...overrides },
    );
  };

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue({ id: ROOM, status: VideoRoomStatus.LIVE }),
      getSettings: jest.fn().mockResolvedValue({ allowGifts: true, metadata: null }),
      getMember: jest.fn().mockResolvedValue(member()),
    };
    moderation = { findActiveBlock: jest.fn().mockResolvedValue(null) };
    config = { get: jest.fn() };
    registry = { register: jest.fn() };
    setGiftConfig();
    handler = new VideoRoomGiftContextHandler(
      rooms as never,
      moderation as never,
      config as never,
      registry as never,
    );
  });

  it('registers itself on module init', () => {
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('declares the VIDEO_ROOM context', () => {
    expect(handler.contextType).toBe(GiftContextType.VIDEO_ROOM);
  });

  it('declares NO onSend — nothing extra inside the money transaction', () => {
    // Viewed through the port (where onSend is optional), it must be absent:
    // video rooms contribute no Postgres work beyond the debit/credits/ledger.
    const asPort: IGiftContextHandler = handler;
    expect(asPort.onSend).toBeUndefined();
    expect(asPort.contextLockKeys).toBeUndefined();
  });

  it('reads maxReceivers from config', () => {
    expect(handler.maxReceivers).toBe(9);
  });

  it('economics return the configured creator rate in basis points', () => {
    expect(handler.economics(REQ as never)).toEqual({ receiverEarningsBps: 3000 });
  });

  describe('validate', () => {
    it('accepts a valid send', async () => {
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('rejects a missing room', async () => {
      rooms.findById.mockResolvedValue(null);
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
      });
    });

    it('rejects a room that is not LIVE', async () => {
      rooms.findById.mockResolvedValue({ id: ROOM, status: VideoRoomStatus.OFFLINE });
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
      });
    });

    it('rejects when settings.allowGifts is false', async () => {
      rooms.getSettings.mockResolvedValue({ allowGifts: false, metadata: null });
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_GIFTS_DISABLED,
      });
    });

    it('rejects a blocked sender even with a stale membership row', async () => {
      moderation.findActiveBlock.mockResolvedValue({ id: 'block-1' });
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.VIDEO_ROOM_BLOCKED,
      });
    });

    it('rejects a sender who is not an active member', async () => {
      rooms.getMember.mockResolvedValue(member({ isActive: false }));
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.NOT_ROOM_MEMBER,
      });
    });

    it('rejects a receiver who is not in the room', async () => {
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(userId === SENDER ? member() : null),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('rejects a viewer receiver when the room disables viewer gifts', async () => {
      rooms.getSettings.mockResolvedValue({
        allowGifts: true,
        metadata: { allowViewerGifts: false },
      });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('allows a viewer receiver when the room enables viewer gifts', async () => {
      rooms.getSettings.mockResolvedValue({
        allowGifts: true,
        metadata: { allowViewerGifts: true },
      });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('falls back to the config default when the room sets no override', async () => {
      setGiftConfig({ allowViewerGiftsDefault: 'false' });
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(
          userId === SENDER ? member() : member({ role: VideoRoomMemberRole.VIEWER }),
        ),
      );
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID,
      });
    });

    it('rejects more receivers than the configured cap', async () => {
      setGiftConfig({ maxReceivers: 2 });
      await expect(
        handler.validate({ ...REQ, receiverIds: ['a', 'b', 'c'] } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
    });

    it('validates every receiver in a batch, not just the first', async () => {
      rooms.getMember.mockImplementation((_room: string, userId: string) =>
        Promise.resolve(userId === 'u2' ? null : member()),
      );
      await expect(
        handler.validate({ ...REQ, receiverIds: ['u1', 'u2'] } as never),
      ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
    });

    it('rejects a sender from a blocked country', async () => {
      setGiftConfig({ blockedCountries: 'XX,YY' });
      rooms.getMember.mockResolvedValue(member({ country: 'xx' }));
      await expect(handler.validate(REQ as never)).rejects.toMatchObject({
        errorCode: ERROR_CODES.GIFT_COUNTRY_RESTRICTED,
      });
    });

    it('allows a sender from a permitted country', async () => {
      setGiftConfig({ blockedCountries: 'XX' });
      rooms.getMember.mockResolvedValue(member({ country: 'IN' }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    /** Blocking on unknown would bar every member who joined before the column was populated. */
    it('allows a member with no recorded country', async () => {
      setGiftConfig({ blockedCountries: 'XX' });
      rooms.getMember.mockResolvedValue(member({ country: null }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('allows everyone when no countries are blocked', async () => {
      rooms.getMember.mockResolvedValue(member({ country: 'XX' }));
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });

    it('treats absent settings as gifting-allowed', async () => {
      rooms.getSettings.mockResolvedValue(null);
      await expect(handler.validate(REQ as never)).resolves.toBeUndefined();
    });
  });
});
