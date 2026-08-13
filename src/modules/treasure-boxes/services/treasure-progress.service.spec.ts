import { TreasureBoxStatus } from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import type { LockService } from 'src/infra/redis/lock.service';
import type { TreasureBoxService } from './treasure-box.service';
import type { TreasureConfigurationService } from './treasure-configuration.service';
import { TreasureProgressService } from './treasure-progress.service';

const ROOM = 'room-1';
const USER = 'user-1';
const SESSION = 'session-1';
const BOX = 'box-1';

describe('TreasureProgressService — ranking vs progress', () => {
  let prisma: {
    treasureSession: { findFirst: jest.Mock; update: jest.Mock };
    treasureBox: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; upsert: jest.Mock };
    treasureContribution: { create: jest.Mock; findFirst: jest.Mock };
  };
  let locks: { withLock: jest.Mock };
  let boxService: { getOrCreateActiveSession: jest.Mock };
  let configService: { getLevelThreshold: jest.Mock };
  let service: TreasureProgressService;

  beforeEach(() => {
    prisma = {
      treasureSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      treasureBox: {
        // A big, half-empty box so one gift is a partial fill and nothing opens.
        findUnique: jest.fn().mockResolvedValue({
          id: BOX,
          sessionId: SESSION,
          roomId: ROOM,
          level: 1,
          threshold: BigInt(10_000),
          progress: BigInt(0),
          status: TreasureBoxStatus.ACTIVE,
        }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      treasureContribution: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    locks = { withLock: jest.fn().mockImplementation((_key, cb) => cb()) };
    boxService = {
      getOrCreateActiveSession: jest
        .fn()
        .mockResolvedValue({ id: SESSION, roomId: ROOM, currentLevel: 1 }),
    };
    configService = { getLevelThreshold: jest.fn().mockResolvedValue(BigInt(10_000)) };

    service = new TreasureProgressService(
      prisma as unknown as PrismaService,
      locks as unknown as LockService,
      boxService as unknown as TreasureBoxService,
      configService as unknown as TreasureConfigurationService,
    );
  });

  it('records a ranking row for an ordinary gift', async () => {
    await service.applyGiftProgress(ROOM, USER, BigInt(500), 'gtxn-1');

    expect(prisma.treasureContribution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ boxId: BOX, userId: USER, amount: BigInt(500) }),
      }),
    );
  });

  it('advances box progress for an ordinary gift', async () => {
    await service.applyGiftProgress(ROOM, USER, BigInt(500), 'gtxn-1');

    expect(prisma.treasureBox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOX },
        data: expect.objectContaining({ progress: BigInt(500) }),
      }),
    );
  });

  // `treasure_contributions` is a pure RANKING ledger — every consumer of it
  // (topContributors, getUserPositionInBox, getEligibleParticipants) decides who
  // wins a box's rewards. Box progress lives on `treasureBox.progress`, which is
  // a separate column. So a self-gift can fill the box without buying its sender
  // a place on the podium, and no schema change is needed to express that.
  it('advances progress for a self-gift but writes NO ranking row', async () => {
    await service.applyGiftProgress(ROOM, USER, BigInt(500), 'gtxn-1', 'AUDIO_ROOM', false);

    expect(prisma.treasureBox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOX },
        data: expect.objectContaining({ progress: BigInt(500) }),
      }),
    );
    expect(prisma.treasureContribution.create).not.toHaveBeenCalled();
  });

  it('still reports the applied amount for a self-gift', async () => {
    const result = await service.applyGiftProgress(
      ROOM,
      USER,
      BigInt(500),
      'gtxn-1',
      'AUDIO_ROOM',
      false,
    );

    expect(result.appliedAmount).toBe(BigInt(500));
    expect(result.sessionId).toBe(SESSION);
  });

  it('writes no ranking row for a self-gift that fills the box completely', async () => {
    prisma.treasureBox.findUnique.mockResolvedValue({
      id: BOX,
      sessionId: SESSION,
      roomId: ROOM,
      level: 1,
      threshold: BigInt(500),
      progress: BigInt(0),
      status: TreasureBoxStatus.ACTIVE,
    });

    const result = await service.applyGiftProgress(
      ROOM,
      USER,
      BigInt(500),
      'gtxn-1',
      'AUDIO_ROOM',
      false,
    );

    // The box still opens — a solo self-gifter can fill it, they just cannot
    // rank for it, so distributeBoxRewards finds no contributors and pays out
    // nothing rather than handing them the podium unopposed.
    expect(result.completedBoxes).toHaveLength(1);
    expect(prisma.treasureContribution.create).not.toHaveBeenCalled();
  });

  it('defaults to ranking when the flag is omitted (backward compatible)', async () => {
    await service.applyGiftProgress(ROOM, USER, BigInt(500));

    expect(prisma.treasureContribution.create).toHaveBeenCalled();
  });

  it('skips duplicate gift progress when giftTxnId already exists', async () => {
    prisma.treasureContribution.findFirst.mockResolvedValueOnce({
      id: 'existing-contrib-1',
      sessionId: SESSION,
      giftTxnId: 'gtxn-dup-1',
    });

    const result = await service.applyGiftProgress(ROOM, USER, BigInt(10_000), 'gtxn-dup-1');

    expect(result.appliedAmount).toBe(BigInt(0));
    expect(prisma.treasureBox.update).not.toHaveBeenCalled();
    expect(prisma.treasureContribution.create).not.toHaveBeenCalled();
  });
});
