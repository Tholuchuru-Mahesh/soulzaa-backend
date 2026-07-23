import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface DefaultPackageSeed {
  code: string;
  name: string;
  coins: bigint;
  bonusCoins: bigint;
  priceAmount: number;
  currency: string;
  country: string;
  platform: string;
  sortOrder: number;
}

export const DEFAULT_COIN_PACKAGES: DefaultPackageSeed[] = [
  {
    code: 'PKG_100_COINS',
    name: '100 Soul Coins',
    coins: BigInt(100),
    bonusCoins: BigInt(0),
    priceAmount: 0.99,
    currency: 'USD',
    country: 'GLOBAL',
    platform: 'ALL',
    sortOrder: 1,
  },
  {
    code: 'PKG_500_COINS',
    name: '500 Soul Coins Starter',
    coins: BigInt(500),
    bonusCoins: BigInt(25),
    priceAmount: 4.99,
    currency: 'USD',
    country: 'GLOBAL',
    platform: 'ALL',
    sortOrder: 2,
  },
  {
    code: 'PKG_1000_COINS',
    name: '1,000 Soul Coins Value',
    coins: BigInt(1000),
    bonusCoins: BigInt(75),
    priceAmount: 9.99,
    currency: 'USD',
    country: 'GLOBAL',
    platform: 'ALL',
    sortOrder: 3,
  },
  {
    code: 'PKG_5000_COINS',
    name: '5,000 Soul Coins Pro',
    coins: BigInt(5000),
    bonusCoins: BigInt(500),
    priceAmount: 49.99,
    currency: 'USD',
    country: 'GLOBAL',
    platform: 'ALL',
    sortOrder: 4,
  },
  {
    code: 'PKG_10000_COINS',
    name: '10,000 Soul Coins Ultimate',
    coins: BigInt(10000),
    bonusCoins: BigInt(1500),
    priceAmount: 99.99,
    currency: 'USD',
    country: 'GLOBAL',
    platform: 'ALL',
    sortOrder: 5,
  },
];

@Injectable()
export class CoinPackageSeederService implements OnModuleInit {
  private readonly logger = new Logger(CoinPackageSeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async seedDefaults() {
    for (const seed of DEFAULT_COIN_PACKAGES) {
      await this.prisma.coinPackage.upsert({
        where: { code: seed.code },
        update: {},
        create: {
          code: seed.code,
          name: seed.name,
          coins: seed.coins,
          bonusCoins: seed.bonusCoins,
          priceAmount: seed.priceAmount,
          currency: seed.currency,
          country: seed.country,
          platform: seed.platform,
          sortOrder: seed.sortOrder,
          isActive: true,
        },
      });
    }
  }
}
