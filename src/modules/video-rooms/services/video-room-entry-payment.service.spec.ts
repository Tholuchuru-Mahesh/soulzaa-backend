import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletCurrency } from '@prisma/client';
import { BusinessException } from 'src/common/exceptions/business.exception';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomEntryPaymentService } from './video-room-entry-payment.service';

describe('VideoRoomEntryPaymentService', () => {
  let service: VideoRoomEntryPaymentService;
  let prisma: any;
  let repo: any;
  let entryAccessRepo: any;
  let walletService: any;
  let locks: any;
  let configService: any;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (cb) => cb(prisma)),
      videoBroadcastSession: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    repo = {
      findById: jest.fn(),
      getActiveBroadcastSession: jest.fn(),
      findBroadcastSessionById: jest.fn(),
    };

    entryAccessRepo = {
      findAccess: jest.fn(),
      hasGrantedAccess: jest.fn(),
      grantAccess: jest.fn(),
    };

    walletService = {
      getBalance: jest.fn(),
      debit: jest.fn(),
      credit: jest.fn(),
    };

    locks = {
      withLock: jest.fn((_key, cb) => cb()),
    };

    configService = {
      get: jest.fn().mockReturnValue({
        defaultMaxParticipants: 10,
        maxParticipantsCap: 50,
        defaultMaxViewers: 500,
        maxViewersCap: 5000,
        heartbeatIntervalSeconds: 30,
        reconnectTimeoutSeconds: 120,
        maxReconnectAttempts: 5,
        idleTimeoutSeconds: 300,
        cleanupIntervalSeconds: 60,
        sessionTtlSeconds: 3600,
        stateTtlSeconds: 3600,
        cacheTtlSeconds: 300,
        defaultQuality: '720p',
        maxBitrateKbps: 2500,
        maxRoomsPerOwner: 1,
        mediaHeartbeatTtlSeconds: 30,
        mediaMonitorIntervalSeconds: 10,
        mediaReconnectGraceSeconds: 60,
        mediaRecoveryTokenTtlSeconds: 60,
        maxSubscriptionsPerUser: 20,
        qualitySampleEvery: 6,
        defaultBeautyLevel: 0,
        viewerPresenceMode: 'durable',
        minEntryFee: 1,
        maxEntryFee: 1000000,
        entryCreatorPercentage: 100,
      }),
    };

    service = new VideoRoomEntryPaymentService(
      prisma,
      repo,
      entryAccessRepo,
      walletService,
      locks,
      configService as unknown as ConfigService,
    );
  });

  describe('checkEntryStatus', () => {
    it('throws 404 when room does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.checkEntryStatus('user-1', 'room-404')).rejects.toThrow(
        BusinessException,
      );
    });

    it('returns alreadyAuthorized: true for the room owner', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'user-host' });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 's1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
      });

      const res = await service.checkEntryStatus('user-host', 'r1');
      expect(res.requiresPayment).toBe(false);
      expect(res.alreadyAuthorized).toBe(true);
      expect(res.isOwnerOrMod).toBe(true);
    });

    it('returns requiresPayment: false for free broadcast sessions', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 's1',
        status: 'LIVE',
        paidEntryEnabled: false,
        entryFee: null,
      });

      const res = await service.checkEntryStatus('viewer-1', 'r1');
      expect(res.requiresPayment).toBe(false);
      expect(res.alreadyAuthorized).toBe(true);
      expect(res.entryFee).toBe(0);
    });

    it('returns requiresPayment: true when paid entry is enabled and user has not paid', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 's1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
      });
      entryAccessRepo.hasGrantedAccess.mockResolvedValue(false);

      const res = await service.checkEntryStatus('viewer-1', 'r1');
      expect(res.requiresPayment).toBe(true);
      expect(res.alreadyAuthorized).toBe(false);
      expect(res.entryFee).toBe(500);
      expect(res.sessionId).toBe('s1');
    });

    it('returns requiresPayment: false when user has already paid for the active session', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.getActiveBroadcastSession.mockResolvedValue({
        id: 's1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
      });
      entryAccessRepo.hasGrantedAccess.mockResolvedValue(true);

      const res = await service.checkEntryStatus('viewer-1', 'r1');
      expect(res.requiresPayment).toBe(false);
      expect(res.alreadyAuthorized).toBe(true);
      expect(res.entryFee).toBe(500);
    });
  });

  describe('payAndGrantAccess', () => {
    const actor = { id: 'viewer-1', roles: [] };

    it('throws when session is ended', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.findBroadcastSessionById.mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        status: 'ENDED',
        paidEntryEnabled: true,
        entryFee: 500n,
      });

      await expect(
        service.payAndGrantAccess(actor, 'r1', 's1', { idempotencyKey: 'idemp-1' }),
      ).rejects.toThrow(BusinessException);
    });

    it('returns existing access if already granted (idempotency)', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.findBroadcastSessionById.mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
      });
      entryAccessRepo.findAccess.mockResolvedValue({
        id: 'acc-1',
        amountPaid: 500n,
        creatorEarnings: 500n,
        status: 'GRANTED',
      });

      const res = await service.payAndGrantAccess(actor, 'r1', 's1', { idempotencyKey: 'idemp-1' });
      expect(res.success).toBe(true);
      expect(res.alreadyAuthorized).toBe(true);
      expect(res.accessId).toBe('acc-1');
      expect(walletService.debit).not.toHaveBeenCalled();
    });

    it('throws PAYMENT_REQUIRED when user has insufficient Gold coins', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.findBroadcastSessionById.mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
        hostId: 'host-1',
      });
      entryAccessRepo.findAccess.mockResolvedValue(null);
      walletService.getBalance.mockResolvedValue({ gold: 100, diamond: 0, game: 0 });

      await expect(
        service.payAndGrantAccess(actor, 'r1', 's1', { idempotencyKey: 'idemp-1' }),
      ).rejects.toThrow(BusinessException);

      expect(walletService.debit).not.toHaveBeenCalled();
    });

    it('successfully deducts Gold, credits host, grants access, and increments session counters', async () => {
      repo.findById.mockResolvedValue({ id: 'r1', ownerId: 'host-1' });
      repo.findBroadcastSessionById.mockResolvedValue({
        id: 's1',
        roomId: 'r1',
        status: 'LIVE',
        paidEntryEnabled: true,
        entryFee: 500n,
        hostId: 'host-1',
      });
      entryAccessRepo.findAccess.mockResolvedValue(null);
      walletService.getBalance.mockResolvedValue({ gold: 1000, diamond: 0, game: 0 });
      prisma.videoBroadcastSession.findUnique.mockResolvedValue({ status: 'LIVE' });

      walletService.debit.mockResolvedValue({ transactionId: 'tx-debit-1', balanceAfter: 500 });
      walletService.credit.mockResolvedValue({ transactionId: 'tx-credit-1', balanceAfter: 500 });
      entryAccessRepo.grantAccess.mockResolvedValue({
        id: 'acc-new-1',
        userId: 'viewer-1',
        roomId: 'r1',
        sessionId: 's1',
        amountPaid: 500n,
        creatorEarnings: 500n,
      });

      const res = await service.payAndGrantAccess(actor, 'r1', 's1', { idempotencyKey: 'idemp-1' });

      expect(res.success).toBe(true);
      expect(res.accessId).toBe('acc-new-1');
      expect(res.amountPaid).toBe(500);
      expect(res.creatorEarnings).toBe(500);

      expect(walletService.debit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'viewer-1',
          currency: WalletCurrency.GOLD,
          amount: 500,
          idempotencyKey: 'idemp-1',
        }),
        expect.anything(),
      );

      expect(walletService.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'host-1',
          currency: WalletCurrency.DIAMOND,
          amount: 500,
        }),
        expect.anything(),
      );

      expect(entryAccessRepo.grantAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'viewer-1',
          roomId: 'r1',
          sessionId: 's1',
          amountPaid: 500n,
          creatorEarnings: 500n,
          transactionId: 'tx-debit-1',
        }),
        expect.anything(),
      );

      expect(prisma.videoBroadcastSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's1' },
          data: {
            totalPaidEntrants: { increment: 1 },
            totalEntryRevenue: { increment: 500n },
            entryCreatorEarnings: { increment: 500n },
          },
        }),
      );
    });
  });
});
