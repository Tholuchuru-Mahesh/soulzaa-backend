import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomGiftTarget } from '../dto/send-video-room-gift.dto';
import { VideoRoomGiftTargetResolver } from './video-room-gift-target.resolver';

const SENDER = 'sender-1';

const seat = (seatIndex: number, occupantUserId: string | null) => ({
  seatIndex,
  occupantUserId,
});

describe('VideoRoomGiftTargetResolver', () => {
  let seats: { getSnapshot: jest.Mock };
  let config: { get: jest.Mock };
  let resolver: VideoRoomGiftTargetResolver;

  const cfg = (overrides: Record<string, unknown> = {}) => ({
    maxReceivers: 9,
    allowRoomAll: 'false',
    allowViewerGiftsDefault: 'true',
    recentFeedSize: 50,
    monitorIntervalSeconds: 15,
    recoveryEnabled: 'false',
    ...overrides,
  });

  beforeEach(() => {
    seats = {
      getSnapshot: jest.fn().mockResolvedValue({
        roomId: 'r1',
        seats: [seat(0, 'u1'), seat(1, null), seat(2, 'u2'), seat(3, SENDER)],
      }),
    };
    config = { get: jest.fn().mockReturnValue(cfg()) };
    resolver = new VideoRoomGiftTargetResolver(seats as never, config as never);
  });

  const dto = (overrides: Record<string, unknown>) => overrides as never;

  it('SINGLE returns the one receiver', async () => {
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SINGLE, receiverId: 'u1' }), SENDER),
    ).resolves.toEqual(['u1']);
  });

  it('MULTI de-duplicates receiver ids', async () => {
    await expect(
      resolver.resolve(
        'r1',
        dto({ target: VideoRoomGiftTarget.MULTI, receiverIds: ['u1', 'u2', 'u1'] }),
        SENDER,
      ),
    ).resolves.toEqual(['u1', 'u2']);
  });

  it('SEAT_ALL returns occupied seats in seat order, excluding the sender', async () => {
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SEAT_ALL }), SENDER),
    ).resolves.toEqual(['u1', 'u2']);
  });

  it('SEAT_ALL lets a seated sender gift everyone else on stage', async () => {
    const receivers = await resolver.resolve(
      'r1',
      dto({ target: VideoRoomGiftTarget.SEAT_ALL }),
      SENDER,
    );
    expect(receivers).not.toContain(SENDER);
    expect(receivers).toHaveLength(2);
  });

  it('SEAT_ALL on an empty stage throws GIFT_RECEIVER_INVALID', async () => {
    seats.getSnapshot.mockResolvedValue({ roomId: 'r1', seats: [seat(0, null)] });
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SEAT_ALL }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
  });

  it('SEAT_ALL with a cold seat cache throws rather than charging for nobody', async () => {
    seats.getSnapshot.mockResolvedValue(null);
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SEAT_ALL }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
  });

  it('SEAT_ALL where the sender is the only occupant throws', async () => {
    seats.getSnapshot.mockResolvedValue({ roomId: 'r1', seats: [seat(0, SENDER)] });
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SEAT_ALL }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
  });

  it('ROOM_ALL is rejected while the flag is off', async () => {
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.ROOM_ALL }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID });
  });

  it('ROOM_ALL resolves once the flag is on', async () => {
    config.get.mockReturnValue(cfg({ allowRoomAll: 'true' }));
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.ROOM_ALL }), SENDER),
    ).resolves.toEqual(['u1', 'u2']);
  });

  it('caps the resolved set at maxReceivers', async () => {
    config.get.mockReturnValue(cfg({ maxReceivers: 1 }));
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SEAT_ALL }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_TOO_MANY_RECEIVERS });
  });

  // ---- Self-gifting: explicit targets keep the sender, broadcasts drop them ----

  it('SINGLE addressed at the sender resolves to a self-gift', async () => {
    await expect(
      resolver.resolve(
        'r1',
        dto({ target: VideoRoomGiftTarget.SINGLE, receiverId: SENDER }),
        SENDER,
      ),
    ).resolves.toEqual([SENDER]);
  });

  it('MULTI containing only the sender resolves to a self-gift', async () => {
    await expect(
      resolver.resolve(
        'r1',
        dto({ target: VideoRoomGiftTarget.MULTI, receiverIds: [SENDER] }),
        SENDER,
      ),
    ).resolves.toEqual([SENDER]);
  });

  it('MULTI keeps the sender alongside other named recipients', async () => {
    await expect(
      resolver.resolve(
        'r1',
        dto({ target: VideoRoomGiftTarget.MULTI, receiverIds: ['u1', SENDER, 'u2'] }),
        SENDER,
      ),
    ).resolves.toEqual(['u1', SENDER, 'u2']);
  });

  it('MULTI still de-duplicates a repeated self-target into one charge', async () => {
    await expect(
      resolver.resolve(
        'r1',
        dto({ target: VideoRoomGiftTarget.MULTI, receiverIds: [SENDER, SENDER] }),
        SENDER,
      ),
    ).resolves.toEqual([SENDER]);
  });

  it('ROOM_ALL still drops the sender — a broadcast must not bill you for yourself', async () => {
    config.get.mockReturnValue(cfg({ allowRoomAll: 'true' }));
    const receivers = await resolver.resolve(
      'r1',
      dto({ target: VideoRoomGiftTarget.ROOM_ALL }),
      SENDER,
    );
    expect(receivers).not.toContain(SENDER);
  });

  it('SINGLE with no receiverId still throws rather than defaulting to the sender', async () => {
    await expect(
      resolver.resolve('r1', dto({ target: VideoRoomGiftTarget.SINGLE }), SENDER),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.GIFT_RECEIVER_INVALID });
  });

  it('rejects an unknown target', async () => {
    await expect(resolver.resolve('r1', dto({ target: 'NOPE' }), SENDER)).rejects.toMatchObject({
      errorCode: ERROR_CODES.GIFT_CONTEXT_INVALID,
    });
  });
});
