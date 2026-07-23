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

export const DEFAULT_GIFTS: DefaultGiftSeed[] = [
  {
    code: 'GIFT_ROSE_01',
    name: 'Red Rose',
    displayName: 'Red Rose',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
    coinValue: 1,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/rose_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/rose_anim.svga',
    priority: 10,
    popularity: 1000,
    sortOrder: 1,
    tags: ['rose', 'love', 'classic'],
  },
  {
    code: 'GIFT_SPORTS_CAR_01',
    name: 'Sports Car',
    displayName: 'Phantom Sports Car',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 100,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/car_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/car_anim.svga',
    priority: 8,
    popularity: 850,
    sortOrder: 2,
    tags: ['car', 'luxury', 'speed'],
  },
  {
    code: 'GIFT_ROCKET_01',
    name: 'Falcon Rocket',
    displayName: 'Falcon Rocket Launch',
    category: GiftCategory.PREMIUM,
    type: GiftType.ANIMATED,
    coinValue: 500,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/rocket_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/rocket_anim.svga',
    priority: 6,
    popularity: 600,
    sortOrder: 3,
    tags: ['rocket', 'space', 'premium'],
  },
  {
    code: 'GIFT_GOLD_CROWN_01',
    name: 'Imperial Crown',
    displayName: 'Imperial Gold Crown',
    category: GiftCategory.VIP,
    type: GiftType.PREMIUM,
    coinValue: 1000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/crown_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/crown_anim.svga',
    priority: 4,
    popularity: 450,
    sortOrder: 4,
    tags: ['crown', 'vip', 'king'],
  },
  {
    code: 'GIFT_GOLDEN_DRAGON_01',
    name: 'Golden Dragon',
    displayName: 'Golden Celestial Dragon',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 5000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/dragon_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/dragon_anim.svga',
    priority: 2,
    popularity: 300,
    sortOrder: 5,
    tags: ['dragon', 'mythic', 'ultimate'],
  },
];

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
        update: {},
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
        update: {},
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
