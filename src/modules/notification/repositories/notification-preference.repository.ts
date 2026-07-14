import { Injectable } from '@nestjs/common';
import { NotificationPreference, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access for `notification_preferences`. Owned by the notification module.
 *
 * There is no `create` — only `upsert`. A user who has never opened Settings has
 * no row, and that must mean "all defaults, everything on", never "nothing is
 * enabled". Reads therefore never fail on a missing row, and the row is written
 * the first time the user actually changes something.
 */
@Injectable()
export class NotificationPreferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(userId: string): Promise<NotificationPreference | null> {
    return this.prisma.notificationPreference.findUnique({ where: { userId } });
  }

  upsert(
    userId: string,
    patch: Prisma.NotificationPreferenceUncheckedUpdateInput,
  ): Promise<NotificationPreference> {
    // The create branch takes the same patch: the first write both materialises the
    // row (at its column defaults) and applies the change, in one round trip. `userId`
    // is set last so a patch can never smuggle in a different one.
    const create = {
      ...patch,
      userId,
    } as Prisma.NotificationPreferenceUncheckedCreateInput;

    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create,
      update: patch,
    });
  }
}
