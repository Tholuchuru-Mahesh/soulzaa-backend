import { VideoRoomGiftLockAccessRepository } from './video-room-gift-lock-access.repository';

describe('VideoRoomGiftLockAccessRepository', () => {
  let repo: VideoRoomGiftLockAccessRepository;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      videoRoomGiftLockAccess: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    repo = new VideoRoomGiftLockAccessRepository(prisma);
  });

  it('findAccess looks up by the (userId, sessionId) unique key', async () => {
    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValue({ id: 'a1', status: 'GRANTED' });
    const result = await repo.findAccess('user-1', 'session-1');
    expect(prisma.videoRoomGiftLockAccess.findUnique).toHaveBeenCalledWith({
      where: { userId_sessionId: { userId: 'user-1', sessionId: 'session-1' } },
    });
    expect(result).toEqual({ id: 'a1', status: 'GRANTED' });
  });

  it('hasGrantedAccess is true only when a GRANTED row exists', async () => {
    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValueOnce({ status: 'GRANTED' });
    expect(await repo.hasGrantedAccess('user-1', 'session-1')).toBe(true);

    prisma.videoRoomGiftLockAccess.findUnique.mockResolvedValueOnce(null);
    expect(await repo.hasGrantedAccess('user-1', 'session-1')).toBe(false);
  });

  it('grantAccess creates a GRANTED row from the given data', async () => {
    prisma.videoRoomGiftLockAccess.create.mockResolvedValue({ id: 'a2' });
    const result = await repo.grantAccess({
      userId: 'user-1',
      roomId: 'room-1',
      sessionId: 'session-1',
      giftId: 'gift-1',
      giftTransactionId: 'txn-1',
    });
    expect(prisma.videoRoomGiftLockAccess.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        giftId: 'gift-1',
        giftTransactionId: 'txn-1',
        status: 'GRANTED',
        grantedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ id: 'a2' });
  });
});
