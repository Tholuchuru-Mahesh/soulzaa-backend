import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomsAdminRepository } from './video-rooms-admin.repository';

describe('VideoRoomsAdminRepository', () => {
  let repository: VideoRoomsAdminRepository;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      $transaction: jest.fn(),
      videoRoom: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
      },
      giftTransaction: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      roomLog: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [VideoRoomsAdminRepository, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    repository = module.get<VideoRoomsAdminRepository>(VideoRoomsAdminRepository);
  });

  it('should list video rooms for administration', async () => {
    prismaMock.$transaction.mockResolvedValueOnce([[{ id: 'room-1' }], 1]);
    const res = await repository.listRooms({ skip: 0, take: 20 });
    expect(res.items.length).toBe(1);
    expect(res.total).toBe(1);
  });

  it('should fetch room detail for administration', async () => {
    prismaMock.videoRoom.findFirst.mockResolvedValueOnce({ id: 'room-1' });
    const res = await repository.getRoomDetail('room-1');
    expect(res?.id).toBe('room-1');
  });

  it('should fetch room gift transactions', async () => {
    prismaMock.$transaction.mockResolvedValueOnce([
      [{ id: 'gift-1', totalCoinValue: BigInt(100), creatorEarnings: BigInt(80) }],
      1,
    ]);

    const res = await repository.getRoomGiftTransactions('room-1', 0, 20);
    expect(res.items.length).toBe(1);
    expect(res.items[0].totalCoinValue).toBe('100');
    expect(res.total).toBe(1);
  });

  it('should fetch room logs', async () => {
    prismaMock.$transaction.mockResolvedValueOnce([
      [{ id: 'log-1', action: 'ADMIN_LOCK_ROOM', roomId: 'room-1' }],
      1,
    ]);

    const res = await repository.getRoomLogs('room-1', 0, 20);
    expect(res.items.length).toBe(1);
    expect(res.total).toBe(1);
  });

  it('should create room log', async () => {
    prismaMock.roomLog.create.mockResolvedValueOnce({ id: 'log-1', action: 'ADMIN_LOCK_ROOM' });

    const log = await repository.createRoomLog({
      roomId: 'room-1',
      action: 'ADMIN_LOCK_ROOM',
      actorId: 'user-1',
    });
    expect(log).toBeDefined();
    expect(prismaMock.roomLog.create).toHaveBeenCalled();
  });
});
