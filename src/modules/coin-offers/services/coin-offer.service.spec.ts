import { Test } from '@nestjs/testing';
import { CoinOfferEligibility } from '@prisma/client';
import { CoinOfferService } from './coin-offer.service';
import { CoinOfferRepository } from '../repositories/coin-offer.repository';

describe('CoinOfferService.resolveEligibleOffer', () => {
  let service: CoinOfferService;
  let repo: { hasCompletedPurchase: jest.Mock; findActiveBySegment: jest.Mock };

  beforeEach(async () => {
    repo = { hasCompletedPurchase: jest.fn(), findActiveBySegment: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [CoinOfferService, { provide: CoinOfferRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(CoinOfferService);
  });

  it('returns the FIRST_PURCHASE_ONLY offer for a user with no completed purchases', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(false);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) =>
      seg === CoinOfferEligibility.FIRST_PURCHASE_ONLY
        ? Promise.resolve({ id: 'offer-1', percentage: 10 })
        : Promise.resolve(null),
    );

    const result = await service.resolveEligibleOffer('user-1');

    expect(result).toEqual({ id: 'offer-1', percentage: 10 });
  });

  it('prefers the EXISTING_USERS_ONLY offer over an ALL_USERS offer for a repeat buyer', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(true);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) => {
      if (seg === CoinOfferEligibility.EXISTING_USERS_ONLY) return Promise.resolve({ id: 'offer-2', percentage: 5 });
      if (seg === CoinOfferEligibility.ALL_USERS) return Promise.resolve({ id: 'offer-3', percentage: 20 });
      return Promise.resolve(null);
    });

    const result = await service.resolveEligibleOffer('user-2');

    expect(result).toEqual({ id: 'offer-2', percentage: 5 });
  });

  it('falls back to ALL_USERS when no segment-specific offer is active', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(true);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) =>
      seg === CoinOfferEligibility.ALL_USERS ? Promise.resolve({ id: 'offer-4', percentage: 15 }) : Promise.resolve(null),
    );

    const result = await service.resolveEligibleOffer('user-3');

    expect(result).toEqual({ id: 'offer-4', percentage: 15 });
  });

  it('returns null when no offer is active for the user at all', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(false);
    repo.findActiveBySegment.mockResolvedValue(null);

    const result = await service.resolveEligibleOffer('user-4');

    expect(result).toBeNull();
  });
});
