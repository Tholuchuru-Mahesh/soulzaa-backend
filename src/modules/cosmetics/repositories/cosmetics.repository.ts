import { Injectable } from '@nestjs/common';
import { Cosmetic, CosmeticPurchase, CosmeticType, Prisma } from '@prisma/client';
import { auditCreate, auditUpdate } from 'src/common/utils/audit.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Data layer for the cosmetics catalog + premium purchase ledger. */
@Injectable()
export class CosmeticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  getById(id: string): Promise<Cosmetic | null> {
    return this.prisma.cosmetic.findUnique({ where: { id } });
  }

  listStore(type?: CosmeticType): Promise<Cosmetic[]> {
    return this.prisma.cosmetic.findMany({
      where: {
        enabled: true,
        isPremium: true,
        ...(type ? { type } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }, { name: 'asc' }],
    });
  }

  findPurchaseByKey(idempotencyKey: string): Promise<CosmeticPurchase | null> {
    return this.prisma.cosmeticPurchase.findUnique({ where: { idempotencyKey } });
  }

  createPurchase(data: {
    userId: string;
    cosmeticId: string;
    price: bigint;
    walletTxnId: string | null;
    backpackItemId: string | null;
    idempotencyKey: string;
  }): Promise<CosmeticPurchase> {
    return this.prisma.cosmeticPurchase.create({ data });
  }

  listPurchases(userId: string, skip: number, take: number): Promise<[CosmeticPurchase[], number]> {
    const where: Prisma.CosmeticPurchaseWhereInput = { userId };
    return this.prisma.$transaction([
      this.prisma.cosmeticPurchase.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.cosmeticPurchase.count({ where }),
    ]);
  }

  findByTypeName(type: CosmeticType, name: string): Promise<Cosmetic | null> {
    return this.prisma.cosmetic.findUnique({ where: { type_name: { type, name } } });
  }

  listActive(type?: CosmeticType): Promise<Cosmetic[]> {
    return this.prisma.cosmetic.findMany({
      where: { enabled: true, ...(type ? { type } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  list(
    skip: number,
    take: number,
    filter: { type?: CosmeticType; enabled?: boolean },
  ): Promise<[Cosmetic[], number]> {
    const where: Prisma.CosmeticWhereInput = {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.enabled !== undefined ? { enabled: filter.enabled } : {}),
    };
    return this.prisma.$transaction([
      this.prisma.cosmetic.findMany({ where, skip, take, orderBy: { sortOrder: 'asc' } }),
      this.prisma.cosmetic.count({ where }),
    ]);
  }

  create(data: Prisma.CosmeticUncheckedCreateInput, actorId: string): Promise<Cosmetic> {
    return this.prisma.cosmetic.create({ data: { ...data, ...auditCreate(actorId) } });
  }

  update(id: string, data: Prisma.CosmeticUpdateInput, actorId: string): Promise<Cosmetic> {
    return this.prisma.cosmetic.update({
      where: { id },
      data: { ...data, ...auditUpdate(actorId) },
    });
  }

  delete(id: string): Promise<Cosmetic> {
    return this.prisma.cosmetic.delete({ where: { id } });
  }

  /** Idempotent seed by (type, name). */
  async seed(data: Prisma.CosmeticUncheckedCreateInput): Promise<boolean> {
    const exists = await this.prisma.cosmetic.count({
      where: { type: data.type, name: data.name },
    });
    if (exists > 0) return false;
    await this.prisma.cosmetic.create({ data });
    return true;
  }
}
