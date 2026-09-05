import { Injectable } from '@nestjs/common';
import { CoinOfferEligibility, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';

@Injectable()
export class CoinOfferRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateCoinOfferDto & { createdBy?: string }) {
    return this.prisma.coinOffer.create({ data });
  }

  update(id: string, data: UpdateCoinOfferDto) {
    return this.prisma.coinOffer.update({ where: { id }, data });
  }

  findById(id: string) {
    return this.prisma.coinOffer.findUnique({ where: { id } });
  }

  list() {
    return this.prisma.coinOffer.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findActiveBySegment(eligibility: CoinOfferEligibility) {
    return this.prisma.coinOffer.findFirst({ where: { eligibility, isActive: true } });
  }

  /** Activates `id`, deactivating any other active offer in the same segment, atomically. */
  async activateExclusive(id: string, eligibility: CoinOfferEligibility) {
    return this.prisma.$transaction(async (tx) => {
      await tx.coinOffer.updateMany({
        where: { eligibility, isActive: true, id: { not: id } },
        data: { isActive: false },
      });
      return tx.coinOffer.update({ where: { id }, data: { isActive: true } });
    });
  }

  deactivate(id: string) {
    return this.prisma.coinOffer.update({ where: { id }, data: { isActive: false } });
  }

  hasCompletedPurchase(userId: string) {
    return this.prisma.purchaseOrder
      .count({ where: { userId, status: PurchaseOrderStatus.COMPLETED } })
      .then((count) => count > 0);
  }
}
