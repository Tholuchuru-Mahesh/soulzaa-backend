import { Injectable } from '@nestjs/common';
import { Prisma, Wallet, WalletCurrency, WalletTransaction } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  getWallet(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async ensureWallet(userId: string): Promise<void> {
    await this.prisma.wallet.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  findByIdempotencyKey(
    idempotencyKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WalletTransaction | null> {
    const client = tx || this.prisma;
    return client.walletTransaction.findUnique({ where: { idempotencyKey } });
  }
}
