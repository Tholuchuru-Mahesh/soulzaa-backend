import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GiftCategory, GiftType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface DefaultCategorySeed {
  code: string;
  name: string;
  description: string;
  sortOrder: number;
}

export interface DefaultGiftSeed {
  code: string;
  name: string;
  displayName: string;
  category: GiftCategory;
  type: GiftType;
  coinValue: number;
  thumbnailUrl: string;
  animationUrl: string;
  priority: number;
  popularity: number;
  sortOrder: number;
  tags: string[];
}

export const DEFAULT_CATEGORIES: DefaultCategorySeed[] = [
  {
    code: 'CLASSIC',
    name: 'Classic Gifts',
    description: 'Popular everyday expressional gifts',
    sortOrder: 1,
  },
  {
    code: 'LUXURY',
    name: 'Luxury Gifts',
    description: 'High-value animated showcase gifts',
    sortOrder: 2,
  },
  {
    code: 'FESTIVAL',
    name: 'Festival & Seasonal',
    description: 'Limited-time seasonal event gifts',
    sortOrder: 3,
  },
  {
    code: 'VIP',
    name: 'VIP Exclusive',
    description: 'Exclusive gifts reserved for VIP members',
    sortOrder: 4,
  },
  {
    code: 'PREMIUM',
    name: 'Premium Animated',
    description: 'Full-screen SVGA and 3D animated gifts',
    sortOrder: 5,
  },
];

export const DEFAULT_GIFTS: DefaultGiftSeed[] = [];

@Injectable()
export class GiftCatalogSeederService implements OnModuleInit {
  private readonly logger = new Logger(GiftCatalogSeederService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async seedDefaults() {
    for (const cat of DEFAULT_CATEGORIES) {
      await this.prisma.giftCategoryEntity.upsert({
        where: { code: cat.code },
        update: {
          name: cat.name,
          description: cat.description,
          sortOrder: cat.sortOrder,
          isActive: true,
        },
        create: {
          code: cat.code,
          name: cat.name,
          description: cat.description,
          sortOrder: cat.sortOrder,
          isActive: true,
        },
      });
    }

    for (const seed of DEFAULT_GIFTS) {
      await this.prisma.gift.upsert({
        where: { code: seed.code },
        update: {
          name: seed.name,
          displayName: seed.displayName,
          category: seed.category,
          type: seed.type,
          coinValue: seed.coinValue,
          thumbnailUrl: seed.thumbnailUrl,
          animationUrl: seed.animationUrl,
          priority: seed.priority,
          popularity: seed.popularity,
          sortOrder: seed.sortOrder,
          tags: seed.tags,
          enabled: true,
        },
        create: {
          code: seed.code,
          name: seed.name,
          displayName: seed.displayName,
          category: seed.category,
          type: seed.type,
          coinValue: seed.coinValue,
          thumbnailUrl: seed.thumbnailUrl,
          animationUrl: seed.animationUrl,
          priority: seed.priority,
          popularity: seed.popularity,
          sortOrder: seed.sortOrder,
          tags: seed.tags,
          enabled: true,
        },
      });
    }
  }
}
