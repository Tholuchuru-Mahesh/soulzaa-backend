import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface DefaultPolicySeed {
  key: string;
  name: string;
  category: string;
  value: bigint;
  minLimit?: bigint;
  maxLimit?: bigint;
  description: string;
}

export const DEFAULT_FINANCIAL_POLICIES: DefaultPolicySeed[] = [
  {
    key: 'max_daily_wallet_credit',
    name: 'Maximum Daily Wallet Credit',
    category: 'WALLET_LIMITS',
    value: BigInt(1000000),
    minLimit: BigInt(1000),
    maxLimit: BigInt(100000000),
    description: 'Maximum coin amount a user wallet can be credited per day',
  },
  {
    key: 'max_daily_wallet_debit',
    name: 'Maximum Daily Wallet Debit',
    category: 'WALLET_LIMITS',
    value: BigInt(1000000),
    minLimit: BigInt(1000),
    maxLimit: BigInt(100000000),
    description: 'Maximum coin amount a user wallet can be debited per day',
  },
  {
    key: 'max_gift_amount',
    name: 'Maximum Single Gift Cap',
    category: 'GIFT_LIMITS',
    value: BigInt(500000),
    minLimit: BigInt(1),
    maxLimit: BigInt(10000000),
    description: 'Maximum coin value allowed for a single virtual gift transaction',
  },
  {
    key: 'max_room_gift_value',
    name: 'Maximum Room Gift Value',
    category: 'GIFT_LIMITS',
    value: BigInt(1000000),
    minLimit: BigInt(1000),
    maxLimit: BigInt(50000000),
    description: 'Maximum aggregate gift value allowed per room session per hour',
  },
  {
    key: 'min_withdrawal_amount',
    name: 'Minimum Withdrawal Bound',
    category: 'WITHDRAWAL_LIMITS',
    value: BigInt(100),
    minLimit: BigInt(10),
    maxLimit: BigInt(10000),
    description: 'Minimum coin amount required for a withdrawal request',
  },
  {
    key: 'max_withdrawal_amount',
    name: 'Maximum Withdrawal Cap',
    category: 'WITHDRAWAL_LIMITS',
    value: BigInt(50000),
    minLimit: BigInt(1000),
    maxLimit: BigInt(1000000),
    description: 'Maximum coin amount allowed for a single withdrawal request',
  },
  {
    key: 'max_coin_purchase_amount',
    name: 'Maximum Single Coin Purchase',
    category: 'SELLER_LIMITS',
    value: BigInt(100000),
    minLimit: BigInt(100),
    maxLimit: BigInt(5000000),
    description: 'Maximum coin purchase quantity allowed per checkout transaction',
  },
];

@Injectable()
export class TreasurySeederService implements OnModuleInit {
  private readonly logger = new Logger(TreasurySeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async seedDefaults() {
    // 1. Ensure TreasuryReserve row exists
    const existingReserve = await this.prisma.treasuryReserve.findFirst();
    if (!existingReserve) {
      await this.prisma.treasuryReserve.create({
        data: {
          maxSupply: BigInt('1000000000000'),
          circulatingSupply: BigInt('500000000'),
          reservedSupply: BigInt('100000000'),
          treasuryBalance: BigInt('400000000'),
          isFrozen: false,
        },
      });
    }

    // 2. Ensure FinancialPolicy rows exist
    for (const seed of DEFAULT_FINANCIAL_POLICIES) {
      const existing = await this.prisma.financialPolicy.findUnique({
        where: { key: seed.key },
      });
      if (!existing) {
        try {
          await this.prisma.financialPolicy.create({
            data: {
              key: seed.key,
              name: seed.name,
              category: seed.category,
              value: seed.value,
              minLimit: seed.minLimit,
              maxLimit: seed.maxLimit,
              description: seed.description,
            },
          });
        } catch {
          // Ignore unique constraint error if concurrently created
        }
      }
    }
  }
}
