import { HttpException } from '@nestjs/common';
import {
  LuckyPacket,
  LuckyPacketDistribution,
  LuckyPacketStatus,
  Prisma,
  RoomMemberRole,
  WalletCurrency,
} from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { LockService } from 'src/infra/redis/lock.service';
import type { IAudioRoomsService } from 'src/modules/audio-rooms/interfaces/audio-rooms.service.interface';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { LuckyPacketRepository } from '../repositories/lucky-packet.repository';
import { LuckyPacketService } from './lucky-packet.service';

const OWNER: RoomActor = { id: 'owner-1', roles: ['USER'] };
const MEMBER: RoomActor = { id: 'member-1', roles: ['USER'] };
const ROOM = 'room-1';
const PACKET = 'packet-1';

function packet(overrides: Partial<LuckyPacket> = {}): LuckyPacket {
  return {
    id: PACKET,
    roomId: ROOM,
    creatorId: OWNER.id,
    currency: WalletCurrency.GOLD,
    totalCoins: 100n,
    winnerCount: 5,
    distribution: LuckyPacketDistribution.RANDOM,
    message: null,
    status: LuckyPacketStatus.ACTIVE,
    remainingCoins: 100n,
    remainingSlots: 5,
    debitTxnId: 'debit-1',
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('LuckyPacketService', () => {
  let repo: jest.Mocked<Pick<
    LuckyPacketRepository,
    'create' | 'findById' | 'findActiveByRoom' | 'applyClaim' | 'setClaimTxn' | 'countClaims'
  >>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let rooms: Record<string, jest.Mock>;
  let wallet: jest.Mocked<IWalletService>;
  let service: LuckyPacketService;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      findActiveByRoom: jest.fn(),
      applyClaim: jest.fn(),
      setClaimTxn: jest.fn().mockResolvedValue(undefined),
      countClaims: jest.fn().mockResolvedValue(0),
    } as never;
    locks = { withLock: jest.fn((_key: string, fn: () => unknown) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as never;
    rooms = {
      getEffectiveRole: jest.fn().mockResolvedValue(RoomMemberRole.OWNER),
      isRoomLive: jest.fn().mockResolvedValue(true),
      assertMember: jest.fn().mockResolvedValue(undefined),
    };
    wallet = {
      ensureWallet: jest.fn(),
      getBalance: jest.fn(),
      debit: jest.fn().mockResolvedValue({
        transactionId: 'debit-1',
        currency: WalletCurrency.GOLD,
        balanceAfter: 900,
        duplicate: false,
      }),
      credit: jest.fn().mockResolvedValue({
        transactionId: 'credit-1',
        currency: WalletCurrency.GOLD,
        balanceAfter: 1000,
        duplicate: false,
      }),
    } as never;

    service = new LuckyPacketService(
      repo as never,
      locks as unknown as LockService,
      bus,
      rooms as unknown as IAudioRoomsService,
      wallet,
    );
  });

  it('debits the creator and persists an ACTIVE packet on create', async () => {
    repo.create.mockResolvedValue(packet());
    await service.create(OWNER, ROOM, {
      totalCoins: 100,
      winnerCount: 5,
      distribution: LuckyPacketDistribution.RANDOM,
      expiresInSeconds: 60,
    });
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER.id, amount: 100 }),
    );
    expect(repo.create).toHaveBeenCalled();
  });

  it('rejects a non-host creator', async () => {
    rooms.getEffectiveRole.mockResolvedValue(RoomMemberRole.LISTENER);
    await expect(
      service.create(MEMBER, ROOM, {
        totalCoins: 100,
        winnerCount: 5,
        distribution: LuckyPacketDistribution.FIXED,
        expiresInSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('credits the claimant a positive share within the pool', async () => {
    repo.findById.mockResolvedValue(packet());
    repo.applyClaim.mockResolvedValue({
      claim: { id: 'claim-1' } as never,
      packet: packet({ remainingSlots: 4, remainingCoins: 80n }),
    });
    const result = (await service.claim(MEMBER, ROOM, PACKET)) as { amount: number };
    expect(result.amount).toBeGreaterThan(0);
    expect(result.amount).toBeLessThanOrEqual(100);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `lucky:claim:${PACKET}:${MEMBER.id}` }),
    );
  });

  it('maps a duplicate-claim unique violation to ALREADY_CLAIMED and never credits', async () => {
    repo.findById.mockResolvedValue(packet());
    repo.applyClaim.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(service.claim(MEMBER, ROOM, PACKET)).rejects.toMatchObject({
      errorCode: 'LUCKY_PACKET_ALREADY_CLAIMED',
    });
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('rejects claiming an exhausted packet', async () => {
    repo.findById.mockResolvedValue(packet({ remainingSlots: 0, status: LuckyPacketStatus.COMPLETED }));
    await expect(service.claim(MEMBER, ROOM, PACKET)).rejects.toMatchObject({
      errorCode: 'LUCKY_PACKET_EXHAUSTED',
    });
  });

  it('gives the last slot the exact remaining pool (sum == total)', async () => {
    repo.findById.mockResolvedValue(packet({ remainingSlots: 1, remainingCoins: 37n }));
    repo.applyClaim.mockResolvedValue({
      claim: { id: 'claim-last' } as never,
      packet: packet({ remainingSlots: 0, remainingCoins: 0n, status: LuckyPacketStatus.COMPLETED }),
    });
    const result = (await service.claim(MEMBER, ROOM, PACKET)) as { amount: number };
    expect(result.amount).toBe(37);
  });
});
