import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BackpackItemEquippedEvent } from 'src/modules/backpack/events/backpack.events';
import { UserProfileUpdatedEvent } from 'src/modules/users/events/user.events';

@Injectable()
export class FrameExpirationScheduler {
  private readonly logger = new Logger(FrameExpirationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async checkExpiredFrames(): Promise<void> {
    try {
      const now = new Date();
      const expired = await this.prisma.userCosmetic.findMany({
        where: {
          expiresAt: { lt: now },
        },
        include: {
          cosmetic: true,
        },
      });

      if (expired.length === 0) return;

      this.logger.log(`Found ${expired.length} expired temporary cosmetics. Processing...`);

      for (const item of expired) {
        await this.prisma.userCosmetic.delete({
          where: { id: item.id },
        });

        if (item.cosmetic?.type === 'FRAME' && item.equipped) {
          const defaultCosmeticId = '00000000-0000-0000-0000-000000000001';
          const hasOther = await this.prisma.userCosmetic.count({
            where: {
              userId: item.userId,
              equipped: true,
              cosmetic: { type: 'FRAME' },
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: now } },
              ],
            },
          });

          if (hasOther === 0) {
            const backupFrame = await this.prisma.userCosmetic.findFirst({
              where: {
                userId: item.userId,
              cosmetic: {
                type: 'FRAME',
                id: { not: defaultCosmeticId },
              },
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: now } },
              ],
            },
            orderBy: {
              updatedAt: 'desc',
            },
          });

          if (backupFrame) {
            await this.prisma.userCosmetic.update({
              where: { id: backupFrame.id },
              data: { equipped: true },
            });

            await this.bus.publish(
              new BackpackItemEquippedEvent({
                userId: item.userId,
                itemId: backupFrame.cosmeticId,
                type: 'FRAME' as any,
              }),
            );
            await this.bus.publish(
              new UserProfileUpdatedEvent({
                userId: item.userId,
                username: '',
                changed: ['frame'],
              }),
            );
            this.logger.debug(`Reverted frame for user ${item.userId} to backup frame ${backupFrame.cosmeticId}.`);
          } else {
            await this.prisma.cosmetic.upsert({
              where: { id: defaultCosmeticId },
              create: {
                id: defaultCosmeticId,
                type: 'FRAME',
                name: 'Default Pink Frame',
                mediaUrl: 'default_pink_frame',
                thumbnailUrl: 'default_pink_frame',
                rarity: 'COMMON',
                enabled: true,
                price: 0,
                isPremium: false,
              },
              update: {},
            });
            await this.prisma.userCosmetic.upsert({
              where: { userId_cosmeticId: { userId: item.userId, cosmeticId: defaultCosmeticId } },
              create: { userId: item.userId, cosmeticId: defaultCosmeticId, equipped: true },
              update: { equipped: true },
            });

            await this.bus.publish(
              new BackpackItemEquippedEvent({
                userId: item.userId,
                itemId: defaultCosmeticId,
                type: 'FRAME' as any,
              }),
            );
            await this.bus.publish(
              new UserProfileUpdatedEvent({
                userId: item.userId,
                username: '',
                changed: ['frame'],
              }),
            );
            this.logger.debug(`Reverted frame for user ${item.userId} to default pink frame.`);
          }
        }
      }
    }
  } catch (err) {
    this.logger.error(`Error in frame expiration scheduler: ${(err as Error).message}`);
  }
}
}

