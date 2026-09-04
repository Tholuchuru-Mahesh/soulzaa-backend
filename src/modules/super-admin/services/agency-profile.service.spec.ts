import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { AgencyProfileService } from './agency-profile.service';

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = '33333333-3333-4333-8333-333333333333';
const WALLET_ID = '44444444-4444-4444-8444-444444444444';

describe('AgencyProfileService', () => {
  let service: AgencyProfileService;

  const prisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    userProfile: { findUnique: jest.fn(), findMany: jest.fn() },
    userRole: { findMany: jest.fn() },
    agencyRelationship: { findMany: jest.fn(), count: jest.fn() },
    agencyActivation: { findUnique: jest.fn() },
    agencySettlement: { aggregate: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    agencyStatistics: { findMany: jest.fn() },
    agencyRewardDistribution: { findMany: jest.fn(), count: jest.fn() },
    coinSellerInventory: { findUnique: jest.fn() },
    coinSellerUserSaleTransaction: { findMany: jest.fn(), count: jest.fn() },
    coinSellerInventoryPurchaseOrder: { findMany: jest.fn(), count: jest.fn() },
    wallet: { findUnique: jest.fn() },
    ledgerEntry: { findMany: jest.fn(), count: jest.fn() },
  };

  const media = { resolve: jest.fn() };

  /** The agency exists and every optional side table is empty unless a test says otherwise. */
  function resetToEmptyAgency() {
    jest.clearAllMocks();

    prisma.user.findUnique.mockResolvedValue({
      id: AGENCY_ID,
      username: 'agency_one',
      fullName: 'Agency One',
      email: 'agency@soulzaa.com',
      mobile: '+919000000000',
      country: 'IN',
      status: 'ACTIVE',
      roles: ['USER', 'AGENCY'],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.userProfile.findUnique.mockResolvedValue(null);
    prisma.userProfile.findMany.mockResolvedValue([]);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.agencyRelationship.findMany.mockResolvedValue([]);
    prisma.agencyRelationship.count.mockResolvedValue(0);
    prisma.agencyActivation.findUnique.mockResolvedValue(null);
    prisma.agencySettlement.aggregate.mockResolvedValue({
      _sum: { agencyCommissionCoins: null },
      _count: { _all: 0 },
    });
    prisma.agencySettlement.findMany.mockResolvedValue([]);
    prisma.agencySettlement.count.mockResolvedValue(0);
    prisma.agencyStatistics.findMany.mockResolvedValue([]);
    prisma.agencyRewardDistribution.findMany.mockResolvedValue([]);
    prisma.agencyRewardDistribution.count.mockResolvedValue(0);
    prisma.coinSellerInventory.findUnique.mockResolvedValue(null);
    prisma.coinSellerUserSaleTransaction.findMany.mockResolvedValue([]);
    prisma.coinSellerUserSaleTransaction.count.mockResolvedValue(0);
    prisma.coinSellerInventoryPurchaseOrder.findMany.mockResolvedValue([]);
    prisma.coinSellerInventoryPurchaseOrder.count.mockResolvedValue(0);
    prisma.wallet.findUnique.mockResolvedValue(null);
    prisma.ledgerEntry.findMany.mockResolvedValue([]);
    prisma.ledgerEntry.count.mockResolvedValue(0);
    media.resolve.mockResolvedValue(null);
  }

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AgencyProfileService,
        { provide: PrismaService, useValue: prisma },
        { provide: MediaUrlResolver, useValue: media },
      ],
    }).compile();

    service = moduleRef.get<AgencyProfileService>(AgencyProfileService);
    resetToEmptyAgency();
  });

  describe('getOverview', () => {
    it('reports the coin seller inventory balances the agency holds', async () => {
      prisma.coinSellerInventory.findUnique.mockResolvedValue({
        id: 'inv-1',
        sellerId: AGENCY_ID,
        country: 'IN',
        purchasedTotal: BigInt(1_000_000),
        availableBalance: BigInt(640_000),
        reservedBalance: BigInt(10_000),
        soldTotal: BigInt(350_000),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      });

      const result = await service.getOverview(AGENCY_ID);

      expect(result.coinSellerInventory).toMatchObject({
        country: 'IN',
        purchasedTotal: '1000000',
        availableBalance: '640000',
        reservedBalance: '10000',
        soldTotal: '350000',
      });
    });

    it('reports the personal wallet balances separately from resale inventory', async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        userId: AGENCY_ID,
        goldBalance: BigInt(5_000),
        diamondBalance: BigInt(2_500),
        gameBalance: BigInt(120),
        lockedBalance: BigInt(0),
        totalRecharged: BigInt(9_000),
        totalSpent: BigInt(4_000),
        status: 'ACTIVE',
        type: 'AGENCY_WALLET',
      });

      const result = await service.getOverview(AGENCY_ID);

      expect(result.wallet).toMatchObject({
        goldBalance: '5000',
        diamondBalance: '2500',
        gameBalance: '120',
        totalRecharged: '9000',
        totalSpent: '4000',
        type: 'AGENCY_WALLET',
      });
    });

    it('sums lifetime commission earnings across every settlement', async () => {
      prisma.agencySettlement.aggregate.mockResolvedValue({
        _sum: { agencyCommissionCoins: BigInt(87_500) },
        _count: { _all: 42 },
      });
      prisma.agencyStatistics.findMany.mockResolvedValue([
        {
          id: 'stat-1',
          period: 'DAILY',
          dateKey: '2026-09-03',
          totalCommissionCoins: BigInt(1_200),
          settlementCount: 3,
          updatedAt: new Date('2026-09-03T00:00:00Z'),
        },
      ]);

      const result = await service.getOverview(AGENCY_ID);

      expect(result.settlement.lifetimeCommissionCoins).toBe('87500');
      expect(result.settlement.settlementCount).toBe(42);
      expect(result.settlement.periods).toEqual([
        expect.objectContaining({
          period: 'DAILY',
          dateKey: '2026-09-03',
          totalCommissionCoins: '1200',
          settlementCount: 3,
        }),
      ]);
    });

    it('reports the host earnings its commission was taken from, so revenue and cut are distinguishable', async () => {
      prisma.agencySettlement.aggregate.mockResolvedValue({
        _sum: { agencyCommissionCoins: BigInt(9_000), hostEarningsCoins: BigInt(90_000) },
        _count: { _all: 12 },
      });

      const result = await service.getOverview(AGENCY_ID);

      expect(result.settlement.lifetimeHostEarningsCoins).toBe('90000');
      expect(result.settlement.lifetimeCommissionCoins).toBe('9000');
    });

    it('returns zeroed balances instead of throwing when the agency has no inventory or wallet row', async () => {
      const result = await service.getOverview(AGENCY_ID);

      expect(result.coinSellerInventory).toMatchObject({
        availableBalance: '0',
        purchasedTotal: '0',
        reservedBalance: '0',
        soldTotal: '0',
      });
      expect(result.wallet).toMatchObject({
        goldBalance: '0',
        diamondBalance: '0',
        gameBalance: '0',
      });
      expect(result.settlement.lifetimeCommissionCoins).toBe('0');
      expect(result.profile.username).toBe('agency_one');
    });

    it('splits member counts into creators and plain users', async () => {
      prisma.agencyRelationship.findMany.mockResolvedValue([
        { hostId: HOST_ID, effectiveFrom: new Date('2026-02-01T00:00:00Z') },
        { hostId: BUYER_ID, effectiveFrom: new Date('2026-03-01T00:00:00Z') },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: HOST_ID, roles: ['USER', 'CREATOR'] },
        { id: BUYER_ID, roles: ['USER'] },
      ]);

      const result = await service.getOverview(AGENCY_ID);

      expect(result.memberCounts).toEqual({ total: 2, creators: 1, users: 1 });
    });

    it('marks the coin seller module as activated once the fee is paid', async () => {
      prisma.agencyActivation.findUnique.mockResolvedValue({
        status: 'ACTIVATED',
        paidAt: new Date('2026-04-01T00:00:00Z'),
        amountMinor: 500000,
        currency: 'INR',
      });

      const result = await service.getOverview(AGENCY_ID);

      expect(result.profile.activationStatus).toBe('ACTIVATED');
      expect(result.profile.coinSellerActivatedAt).toEqual(new Date('2026-04-01T00:00:00Z'));
    });

    it('rejects an agency id that matches no user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getOverview(AGENCY_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getActivity', () => {
    it('names the buyer on every coin sale so the admin sees who received the coins', async () => {
      prisma.coinSellerUserSaleTransaction.findMany.mockResolvedValue([
        {
          id: 'sale-1',
          buyerId: BUYER_ID,
          coinAmount: BigInt(2_500),
          sellerCountry: 'IN',
          buyerCountry: 'IN',
          status: 'COMPLETED',
          buyerWalletTxnId: 'txn-1',
          paymentProofRef: 'UPI-9911',
          createdAt: new Date('2026-08-20T10:00:00Z'),
        },
      ]);
      prisma.coinSellerUserSaleTransaction.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        {
          id: BUYER_ID,
          username: 'buyer_one',
          fullName: 'Buyer One',
          country: 'IN',
          status: 'ACTIVE',
        },
      ]);
      prisma.userProfile.findMany.mockResolvedValue([
        { userId: BUYER_ID, avatarKey: 'avatars/buyer.png' },
      ]);
      media.resolve.mockResolvedValue('https://cdn.soulzaa.com/avatars/buyer.png');

      const result = await service.getActivity(AGENCY_ID, 'coin-sales', 1, 20);

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'sale-1',
        coinAmount: '2500',
        status: 'COMPLETED',
        buyer: {
          id: BUYER_ID,
          username: 'buyer_one',
          fullName: 'Buyer One',
          avatarUrl: 'https://cdn.soulzaa.com/avatars/buyer.png',
        },
      });
    });

    it('leaves the buyer null when the buyer account no longer exists', async () => {
      prisma.coinSellerUserSaleTransaction.findMany.mockResolvedValue([
        {
          id: 'sale-2',
          buyerId: BUYER_ID,
          coinAmount: BigInt(100),
          sellerCountry: 'IN',
          buyerCountry: 'IN',
          status: 'COMPLETED',
          createdAt: new Date('2026-08-21T10:00:00Z'),
        },
      ]);
      prisma.coinSellerUserSaleTransaction.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([]);

      const result = await service.getActivity(AGENCY_ID, 'coin-sales', 1, 20);

      expect(result.items[0]).toMatchObject({ id: 'sale-2', buyer: null });
    });

    it('pages inventory purchases with the requested offset', async () => {
      prisma.coinSellerInventoryPurchaseOrder.findMany.mockResolvedValue([
        {
          id: 'po-1',
          packageCode: 'PKG_500K',
          coinAmount: BigInt(500_000),
          priceAmount: '250000.00',
          priceCurrency: 'INR',
          status: 'CREDITED',
          paymentProvider: 'razorpay',
          providerTxnRef: 'pay_123',
          approvedAt: new Date('2026-06-01T00:00:00Z'),
          creditedAt: new Date('2026-06-01T00:05:00Z'),
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ]);
      prisma.coinSellerInventoryPurchaseOrder.count.mockResolvedValue(31);

      const result = await service.getActivity(AGENCY_ID, 'inventory-purchases', 3, 10);

      expect(prisma.coinSellerInventoryPurchaseOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10, where: { sellerId: AGENCY_ID } }),
      );
      expect(result).toMatchObject({ total: 31, page: 3, limit: 10 });
      expect(result.items[0]).toMatchObject({ packageCode: 'PKG_500K', coinAmount: '500000' });
    });

    it('reads the wallet ledger through the agency wallet', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: WALLET_ID, userId: AGENCY_ID });
      prisma.ledgerEntry.findMany.mockResolvedValue([
        {
          id: 'led-1',
          type: 'CREDIT',
          currency: 'GOLD',
          reason: 'SYSTEM_TRANSFER',
          amount: BigInt(700),
          balanceBefore: BigInt(300),
          balanceAfter: BigInt(1_000),
          description: 'Settlement payout',
          referenceType: 'agency_settlement',
          referenceId: 'set-1',
          createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ]);
      prisma.ledgerEntry.count.mockResolvedValue(1);

      const result = await service.getActivity(AGENCY_ID, 'wallet-ledger', 1, 20);

      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { walletId: WALLET_ID } }),
      );
      expect(result.items[0]).toMatchObject({
        amount: '700',
        balanceBefore: '300',
        balanceAfter: '1000',
        type: 'CREDIT',
      });
    });

    it('returns an empty ledger page when the agency has no wallet at all', async () => {
      const result = await service.getActivity(AGENCY_ID, 'wallet-ledger', 1, 20);

      expect(result).toMatchObject({ items: [], total: 0 });
      expect(prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
    });

    it('names the host on each settlement row', async () => {
      prisma.agencySettlement.findMany.mockResolvedValue([
        {
          id: 'set-1',
          hostId: HOST_ID,
          hostEarningsCoins: BigInt(10_000),
          commissionPercentage: 10,
          agencyCommissionCoins: BigInt(1_000),
          status: 'COMPLETED',
          createdAt: new Date('2026-07-02T00:00:00Z'),
        },
      ]);
      prisma.agencySettlement.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        {
          id: HOST_ID,
          username: 'host_one',
          fullName: 'Host One',
          country: 'IN',
          status: 'ACTIVE',
        },
      ]);

      const result = await service.getActivity(AGENCY_ID, 'settlements', 1, 20);

      expect(result.items[0]).toMatchObject({
        agencyCommissionCoins: '1000',
        hostEarningsCoins: '10000',
        host: { id: HOST_ID, username: 'host_one' },
      });
    });

    it('names the recipient on each reward the agency distributed', async () => {
      prisma.agencyRewardDistribution.findMany.mockResolvedValue([
        {
          id: 'rew-1',
          recipientId: BUYER_ID,
          itemType: 'FRAME',
          refId: 'frame-9',
          name: 'Golden Frame',
          quantity: 1,
          kind: 'ASSIGNED',
          note: 'Top performer',
          createdAt: new Date('2026-07-05T00:00:00Z'),
        },
      ]);
      prisma.agencyRewardDistribution.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        {
          id: BUYER_ID,
          username: 'member_one',
          fullName: 'Member One',
          country: 'IN',
          status: 'ACTIVE',
        },
      ]);

      const result = await service.getActivity(AGENCY_ID, 'rewards', 1, 20);

      expect(result.items[0]).toMatchObject({
        name: 'Golden Frame',
        kind: 'ASSIGNED',
        recipient: { id: BUYER_ID, username: 'member_one' },
      });
    });

    it('rejects an unknown activity type rather than returning an empty page', async () => {
      await expect(
        service.getActivity(AGENCY_ID, 'not-a-real-type' as never, 1, 20),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
