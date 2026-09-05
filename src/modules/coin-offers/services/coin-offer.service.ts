import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CoinOfferEligibility } from '@prisma/client';
import { CoinOfferRepository } from '../repositories/coin-offer.repository';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';

@Injectable()
export class CoinOfferService {
  constructor(private readonly repo: CoinOfferRepository) {}

  list() {
    return this.repo.list();
  }

  async create(actorId: string, dto: CreateCoinOfferDto) {
    const offer = await this.repo.create({ ...dto, createdBy: actorId });
    if (dto.isActive !== false) {
      return this.repo.activateExclusive(offer.id, offer.eligibility);
    }
    return offer;
  }

  async update(id: string, dto: UpdateCoinOfferDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Coin offer not found');
    if (dto.percentage !== undefined && (dto.percentage < 1 || dto.percentage > 1000)) {
      throw new BadRequestException('percentage must be between 1 and 1000');
    }
    return this.repo.update(id, dto);
  }

  async toggle(id: string, isActive: boolean) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Coin offer not found');
    if (!isActive) return this.repo.deactivate(id);
    return this.repo.activateExclusive(id, existing.eligibility);
  }

  /**
   * Resolves which offer (if any) the given user is eligible for right now.
   * Priority when both a segment-specific and an ALL_USERS offer are active
   * simultaneously: the segment-specific one wins (it's the more targeted
   * promotion).
   */
  async resolveEligibleOffer(userId: string): Promise<{ id: string; percentage: number } | null> {
    const hasCompleted = await this.repo.hasCompletedPurchase(userId);
    const segment: CoinOfferEligibility = hasCompleted
      ? CoinOfferEligibility.EXISTING_USERS_ONLY
      : CoinOfferEligibility.FIRST_PURCHASE_ONLY;

    const segmentOffer = await this.repo.findActiveBySegment(segment);
    if (segmentOffer) return { id: segmentOffer.id, percentage: segmentOffer.percentage };

    const allUsersOffer = await this.repo.findActiveBySegment(CoinOfferEligibility.ALL_USERS);
    if (allUsersOffer) return { id: allUsersOffer.id, percentage: allUsersOffer.percentage };

    return null;
  }
}
