import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateTierInput {
  level: number;
  name: string;
  price: bigint;
  durationDays?: number;
  requiredExp?: bigint;
  requiredSpending?: bigint;
  badge?: string;
  frame?: string;
  entranceEffect?: string;
  chatBubble?: string;
  nameColor?: string;
  giftDiscount?: number;
  storeDiscount?: number;
  maxRooms?: number;
  dailyRewards?: any;
}

@Injectable()
export class VipTierService implements OnModuleInit {
  private readonly logger = new Logger(VipTierService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaultTiersIfEmpty();
  }

  /**
   * Seeds default VIP Tiers (VIP 1 to VIP 10) if no tiers exist.
   */
  async seedDefaultTiersIfEmpty() {
    const count = await this.prisma.vipTier.count();
    if (count > 0) return;

    this.logger.log('Seeding default VIP 1 to VIP 10 Tiers...');

    const defaultTiers = Array.from({ length: 10 }, (_, i) => {
      const level = i + 1;
      return {
        level,
        name: `VIP ${level}`,
        displayOrder: level,
        requiredExp: BigInt(level * 5000),
        requiredSpending: BigInt(level * 1000),
        subscriptionType: 'MONTHLY',
        durationDays: 30,
        price: BigInt(level * 500),
        badge: `badge_vip_${level}`,
        frame: `frame_vip_${level}`,
        entranceEffect: `entrance_vip_${level}`,
        chatBubble: `bubble_vip_${level}`,
        nameColor: level >= 5 ? '#FFD700' : '#C0C0C0',
        giftDiscount: Number((level * 1.5).toFixed(1)),
        storeDiscount: Number((level * 1.0).toFixed(1)),
        dailyRewards: JSON.parse(JSON.stringify([{ type: 'COIN', amount: level * 10 }])),
        maxRooms: 1 + Math.floor(level / 3),
        priorityMatching: level >= 5,
        status: 'ACTIVE',
      };
    });

    for (const tier of defaultTiers) {
      await this.prisma.vipTier.upsert({
        where: { level: tier.level },
        update: tier,
        create: tier,
      });
    }
  }

  /**
   * List all active VIP Tiers.
   */
  async getActiveTiers() {
    const tiers = await this.prisma.vipTier.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { level: 'asc' },
    });

    return tiers.map((t) => ({
      ...t,
      requiredExp: t.requiredExp.toString(),
      requiredSpending: t.requiredSpending.toString(),
      price: t.price.toString(),
    }));
  }

  /**
   * Get VIP tier by level.
   */
  async getTierByLevel(level: number) {
    const tier = await this.prisma.vipTier.findUnique({
      where: { level },
    });
    if (!tier) return null;

    return {
      ...tier,
      requiredExp: tier.requiredExp.toString(),
      requiredSpending: tier.requiredSpending.toString(),
      price: tier.price.toString(),
    };
  }

  /**
   * Get raw VIP tier model by level or ID.
   */
  async getTierEntity(levelOrId: number | string) {
    if (typeof levelOrId === 'number') {
      return this.prisma.vipTier.findUnique({ where: { level: levelOrId } });
    }
    return this.prisma.vipTier.findUnique({ where: { id: levelOrId } });
  }
}
