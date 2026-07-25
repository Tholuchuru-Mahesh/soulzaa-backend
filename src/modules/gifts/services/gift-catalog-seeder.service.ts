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
    code: 'GIFT_HEART_01',
    name: 'Flying Heart',
    displayName: 'Flying Heart',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
    coinValue: 5,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/heart_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/heart_anim.svga',
    priority: 9,
    popularity: 950,
    sortOrder: 2,
    tags: ['heart', 'love', 'classic'],
  },
  {
    code: 'GIFT_CHOCOLATE_01',
    name: 'Chocolate Box',
    displayName: 'Sweet Chocolate Box',
    category: GiftCategory.CLASSIC,
    type: GiftType.STATIC,
    coinValue: 10,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/chocolate_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/chocolate_anim.svga',
    priority: 9,
    popularity: 900,
    sortOrder: 3,
    tags: ['chocolate', 'sweet', 'classic'],
  },
  {
    code: 'GIFT_TEDDY_01',
    name: 'Cute Teddy',
    displayName: 'Teddy Bear',
    category: GiftCategory.CLASSIC,
    type: GiftType.ANIMATED,
    coinValue: 50,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/teddy_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/teddy_anim.svga',
    priority: 8,
    popularity: 880,
    sortOrder: 4,
    tags: ['teddy', 'cute', 'classic'],
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
    sortOrder: 5,
    tags: ['car', 'luxury', 'speed'],
  },
  {
    code: 'GIFT_RING_01',
    name: 'Diamond Ring',
    displayName: 'Solitaire Diamond Ring',
    category: GiftCategory.VIP,
    type: GiftType.STATIC,
    coinValue: 200,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/ring_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/ring_anim.svga',
    priority: 7,
    popularity: 750,
    sortOrder: 6,
    tags: ['ring', 'diamond', 'vip'],
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
    sortOrder: 7,
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
    priority: 5,
    popularity: 450,
    sortOrder: 8,
    tags: ['crown', 'vip', 'king'],
  },
  {
    code: 'GIFT_CASTLE_01',
    name: 'Love Castle',
    displayName: 'Royal Love Castle',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 2000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/castle_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/castle_anim.svga',
    priority: 4,
    popularity: 400,
    sortOrder: 9,
    tags: ['castle', 'luxury', 'royal'],
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
    priority: 3,
    popularity: 300,
    sortOrder: 10,
    tags: ['dragon', 'mythic', 'ultimate'],
  },
  {
    code: 'GIFT_JET_01',
    name: 'Private Jet',
    displayName: 'Superjet 9000',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 10000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/jet_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/jet_anim.svga',
    priority: 2,
    popularity: 250,
    sortOrder: 11,
    tags: ['jet', 'plane', 'luxury'],
  },
  {
    code: 'GIFT_YACHT_01',
    name: 'Super Yacht',
    displayName: 'Ocean Sovereign Super Yacht',
    category: GiftCategory.LUXURY,
    type: GiftType.ANIMATED,
    coinValue: 20000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/yacht_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/yacht_anim.svga',
    priority: 2,
    popularity: 200,
    sortOrder: 12,
    tags: ['yacht', 'ocean', 'luxury'],
  },
  {
    code: 'GIFT_PHOENIX_01',
    name: 'Phoenix Rising',
    displayName: 'Eternal Phoenix Fire',
    category: GiftCategory.PREMIUM,
    type: GiftType.ANIMATED,
    coinValue: 50000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/phoenix_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/phoenix_anim.svga',
    priority: 1,
    popularity: 150,
    sortOrder: 13,
    tags: ['phoenix', 'fire', 'premium'],
  },
  {
    code: 'GIFT_STARSHIP_01',
    name: 'Galaxy Starship',
    displayName: 'Cosmic Starship Sovereign',
    category: GiftCategory.PREMIUM,
    type: GiftType.ANIMATED,
    coinValue: 100000,
    thumbnailUrl: 'https://cdn.soulzaa.com/gifts/starship_thumb.png',
    animationUrl: 'https://cdn.soulzaa.com/gifts/starship_anim.svga',
    priority: 1,
    popularity: 100,
    sortOrder: 14,
    tags: ['starship', 'galaxy', 'ultimate'],
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
